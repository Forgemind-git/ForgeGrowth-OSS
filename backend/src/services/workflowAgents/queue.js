// BullMQ queue for workflow agent runs. The Redis connection is opened lazily so
// that requiring the runtime (tests, scripts) never holds the event loop open.

const QUEUE_NAME = 'forgegrowth-workflow-agent';
const CONCURRENCY = parseInt(process.env.WORKFLOW_AGENT_CONCURRENCY || '2', 10);

let connection = null;
let queue = null;
let worker = null;

function conn() {
  if (!connection) {
    const IORedis = require('ioredis');
    connection = new IORedis(process.env.REDIS_URL || 'redis://redis:6379', { maxRetriesPerRequest: null, enableReadyCheck: false });
    connection.on('error', err => console.error('[workflow-agent-queue] redis error:', err.message));
  }
  return connection;
}

function getQueue() {
  if (!queue) {
    const { Queue } = require('bullmq');
    queue = new Queue(QUEUE_NAME, { connection: conn() });
  }
  return queue;
}

/**
 * attempts: 1 — a failed agent run is NOT retried automatically: a retry repeats
 * every model call and costs money again. The SDK already retries transient API
 * errors inside a call; a person can re-run from the Runs tab.
 */
async function enqueueRun(runId) {
  await getQueue().add('run', { runId: String(runId) }, {
    jobId: `wfrun-${runId}`,
    attempts: 1,
    removeOnComplete: { count: 500, age: 86400 },
    removeOnFail: { count: 500, age: 7 * 86400 },
  });
}

function startWorkflowAgentWorker() {
  if (worker) return worker;
  const { Worker } = require('bullmq');
  const { executeRun } = require('./runtime');
  worker = new Worker(QUEUE_NAME, async (job) => executeRun(Number(job.data.runId)), { connection: conn(), concurrency: CONCURRENCY });
  worker.on('completed', (job, r) => console.log(`[workflow-agent-queue] run ${job.data.runId} → ${r?.status || r?.skipped || 'done'}`));
  worker.on('failed', (job, err) => console.error(`[workflow-agent-queue] run ${job?.data?.runId} crashed: ${err?.message}`));
  console.log(`[workflow-agent-queue] worker started, concurrency=${CONCURRENCY}`);
  return worker;
}

async function shutdownWorkflowAgentQueue() {
  try {
    if (worker) await worker.close();
    if (queue) await queue.close();
    if (connection) await connection.quit();
  } catch (e) {
    console.error('[workflow-agent-queue] shutdown error:', e.message);
  }
}

module.exports = { QUEUE_NAME, enqueueRun, startWorkflowAgentWorker, shutdownWorkflowAgentQueue };
