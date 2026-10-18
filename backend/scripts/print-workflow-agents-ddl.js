// Prints migration 121 from its source of truth (services/workflowAgents/schema.js).
//   node scripts/print-workflow-agents-ddl.js > ../supabase/migrations/121_workflow_agents.sql
// test/workflowAgents.unit.test.js fails if the committed .sql file drifts from it.
process.stdout.write(require('../src/services/workflowAgents/schema').DDL);
