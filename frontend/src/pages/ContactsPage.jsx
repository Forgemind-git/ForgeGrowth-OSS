import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { notify } from '../lib/feedback.js';
import { Users, Search, Phone, User, Pencil, Trash2, Loader2, ChevronDown, X, Tag, Filter, Send, Play, Music, FileText, Image, Video, Library, Upload, Download, FileSpreadsheet, CheckCircle2, AlertTriangle } from 'lucide-react';
import DeleteConfirmModal from '../components/DeleteConfirmModal.jsx';
import WhatsAppPreview, { BroadcastMessagePreview } from '../components/WhatsAppPreview.jsx';
import TagMultiSelect from '../components/TagMultiSelect.jsx';
import { api } from '../api.js';
import { useServerEvents } from '../hooks/useServerEvents.js';
import { C, FONT, maskPhone } from '../constants.js';
import MaskedNumber from '../components/MaskedNumber.jsx';
import SearchableSelect from '../components/SearchableSelect.jsx';

function TagBadge({ tag, onRemove }) {
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 4,
      padding: '3px 8px', borderRadius: 4,
      background: tag.color,
      color: '#fff',
      border: `1px solid ${tag.color}`,
      fontSize: 11, fontWeight: 700,
      fontFamily: FONT,
    }}>
      {tag.name}
      {onRemove && (
        <button onClick={onRemove} style={{
          border: 'none', background: 'transparent', cursor: 'pointer',
          color: 'inherit', padding: 0, display: 'flex', alignItems: 'center',
        }}>
          <X size={10} />
        </button>
      )}
    </span>
  );
}

export default function ContactsPage({ user, onNavigate }) {
  const isAdmin = user?.role === 'admin';
  const [numbers, setNumbers] = useState([]);
  const [selectedNumber, setSelectedNumber] = useState(null);
  const [contacts, setContacts] = useState([]);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState('');
  const [filterTagIds, setFilterTagIds] = useState([]);

  const [categories, setCategories] = useState([]);
  const [tags, setTags] = useState([]);
  const [contactFields, setContactFields] = useState([]);
  const [teamMembers, setTeamMembers] = useState([]);

  const [detailContact, setDetailContact] = useState(null);
  const [detailName, setDetailName] = useState('');
  const [detailNumber, setDetailNumber] = useState('');
  const [detailTags, setDetailTags] = useState([]);
  const [detailCustomFields, setDetailCustomFields] = useState({});
  const [fieldErrors, setFieldErrors] = useState({});
  const [detailLoading, setDetailLoading] = useState(false);
  const [savingDetail, setSavingDetail] = useState(false);
  const [detailMode, setDetailMode] = useState('view'); // 'view' | 'edit'
  const [detailAssignedUserId, setDetailAssignedUserId] = useState(null);
  const [detailAssignedUserName, setDetailAssignedUserName] = useState(null);
  const [usersForAssign, setUsersForAssign] = useState([]); // [] when not admin or load failed
  const [deleteModal, setDeleteModal] = useState({ open: false, contact: null });
  const [selectedContacts, setSelectedContacts] = useState(new Set());
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);
  const [broadcastModal, setBroadcastModal] = useState(false);
  const [broadcastMessage, setBroadcastMessage] = useState('');
  const [broadcasting, setBroadcasting] = useState(false);
  const [templates, setTemplates] = useState([]);
  const [broadcastFrom, setBroadcastFrom] = useState('');
  const [broadcastTemplateId, setBroadcastTemplateId] = useState('');
  const [broadcastName, setBroadcastName] = useState('');
  const [testNumber, setTestNumber] = useState('');
  const [sendingTest, setSendingTest] = useState(false);
  const [broadcastVariableMapping, setBroadcastVariableMapping] = useState({});
  const [testNumberSearch, setTestNumberSearch] = useState('');
  const [testNumberOpen, setTestNumberOpen] = useState(false);
  const testNumRef = useRef(null);
  const [showBroadcastConfirm, setShowBroadcastConfirm] = useState(false);
  const [broadcastMessageType, setBroadcastMessageType] = useState('template');
  const [broadcastBody, setBroadcastBody] = useState('');
  const [broadcastUrl, setBroadcastUrl] = useState('');
  const [broadcastMediaLibraryId, setBroadcastMediaLibraryId] = useState('');
  const [broadcastMediaItems, setBroadcastMediaItems] = useState([]);
  const [broadcastCaption, setBroadcastCaption] = useState('');
  const [broadcastMediaLoading, setBroadcastMediaLoading] = useState(false);

  // Import contacts modal
  const [importModal, setImportModal] = useState(false);
  const [importFile, setImportFile] = useState(null);
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState(null);
  const [importError, setImportError] = useState('');

  // Load numbers on mount
  useEffect(() => {
    api.numbers()
      .then(data => {
        setNumbers(data);
        if (data.length > 0) setSelectedNumber(data[0].wa_number);
      })
      .catch(() => setNumbers([]));
  }, []);

  // Load saved contacts when number changes — polled every 5s so that admin
  // reassignments propagate to BDAs without a manual refresh.
  const loadContacts = useCallback((quiet = false) => {
    if (!selectedNumber) return;
    if (!quiet) setLoading(true);
    api.savedContacts(selectedNumber)
      .then(data => setContacts(data.map(c => ({ ...c, tags: c.tags || [] }))))
      .catch(() => setContacts([]))
      .finally(() => { if (!quiet) setLoading(false); });
  }, [selectedNumber]);

  useEffect(() => {
    loadContacts();
  }, [loadContacts]);

  // Close the test-number combobox on outside click.
  useEffect(() => {
    if (!testNumberOpen) return;
    const onDown = (e) => { if (testNumRef.current && !testNumRef.current.contains(e.target)) setTestNumberOpen(false); };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [testNumberOpen]);

  // Fallback polling at 30s; SSE pushes the fast path.
  useEffect(() => {
    if (!selectedNumber) return;
    const t = setInterval(() => loadContacts(true), 30000);
    return () => clearInterval(t);
  }, [selectedNumber, loadContacts]);

  // Real-time refresh on contact / assignment events for the current wa_number
  useServerEvents(useCallback((ev) => {
    if (ev.type === 'contact-assignment-changed' || ev.type === 'contact-saved') {
      if (!ev.data?.waNumber || ev.data.waNumber === selectedNumber) loadContacts(true);
    }
  }, [loadContacts, selectedNumber]));

  // Load categories, tags, and contact fields
  useEffect(() => {
    Promise.all([
      api.categories.list().catch(() => []),
      api.tags.list().catch(() => []),
      api.contactFields.list().catch(() => []),
      api.teamMembers.list().catch(() => []),
    ]).then(([cats, tgs, flds, tms]) => {
      setCategories(cats);
      setTags(tgs);
      setContactFields(flds);
      setTeamMembers(tms);
    });
  }, []);

  const openDetail = async (contact, mode = 'view') => {
    setDetailContact(contact);
    setDetailName(contact.name || '');
    setDetailNumber(contact.contact_number || '');
    setDetailTags(contact.tags || []);
    setDetailCustomFields(contact.custom_fields || {});
    setDetailAssignedUserId(contact.assigned_user_id ?? null);
    setDetailAssignedUserName(contact.assigned_user_name ?? null);
    setFieldErrors({});
    setDetailMode(mode);
    setDetailLoading(true);
    // Pull fresh detail + (admin-only) user list for the assignee picker. Both
    // run in parallel; non-admins get 403 on /users which we treat as "hide
    // picker".
    try {
      const [data, usrs] = await Promise.all([
        api.contact(selectedNumber, contact.contact_number),
        isAdmin ? api.users.list().catch(() => []) : Promise.resolve([]),
      ]);
      setDetailTags(data.tags || []);
      setDetailCustomFields(data.custom_fields || {});
      if (data.assigned_user_id !== undefined) setDetailAssignedUserId(data.assigned_user_id);
      setUsersForAssign((usrs || []).filter(u => u.isActive !== false));
    } catch (err) {
      console.error('Failed to load contact detail:', err);
    } finally {
      setDetailLoading(false);
    }
  };

  const validateField = (field, value) => {
    if (!value || !value.trim()) return '';
    switch (field.field_type) {
      case 'number':
        if (!/^\d*\.?\d*$/.test(value)) return 'Must be a valid number';
        break;
      case 'phone':
        if (!/^[\d\s+\-\(\)]*$/.test(value)) return 'Must be a valid phone number';
        break;
      case 'email':
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return 'Must be a valid email';
        break;
      case 'url':
        if (!/^https?:\/\/.+/.test(value)) return 'Must start with http:// or https://';
        break;
      default:
        break;
    }
    return '';
  };

  const isFormValid = () => {
    const errors = {};
    contactFields.forEach(field => {
      const val = detailCustomFields[field.id] || '';
      const err = validateField(field, val);
      if (err) errors[field.id] = err;
    });
    setFieldErrors(errors);
    return Object.keys(errors).length === 0;
  };

  const handleCustomFieldChange = (fieldId, value) => {
    setDetailCustomFields(prev => ({ ...prev, [fieldId]: value }));
    const field = contactFields.find(f => f.id === fieldId);
    if (field) {
      const err = validateField(field, value);
      setFieldErrors(prev => ({ ...prev, [fieldId]: err }));
    }
  };

  const saveDetail = async () => {
    if (!detailContact) return;
    if (!isFormValid()) return;

    const oldNumber = detailContact.contact_number;
    const newNumber = String(detailNumber || '').replace(/\D/g, '');
    const numberChanged = newNumber && newNumber !== String(oldNumber);
    if (detailNumber && newNumber.length < 7) {
      notify('Enter a valid phone number (digits only, at least 7 digits).');
      return;
    }

    setSavingDetail(true);
    try {
      // If the number changed, migrate the conversation + history first. This is
      // transactional server-side; the contact key changes so we refetch after.
      if (numberChanged) {
        await api.changeContactNumber(selectedNumber, oldNumber, newNumber);
      }
      const effectiveNumber = numberChanged ? newNumber : oldNumber;

      // Only admin can change the assignee. For non-admin the picker isn't
      // even rendered, so detailAssignedUserId stays at the loaded value and
      // we pass undefined to leave the column untouched server-side.
      const assignedArg = isAdmin ? (detailAssignedUserId == null ? null : Number(detailAssignedUserId)) : undefined;
      await api.saveContact(selectedNumber, effectiveNumber, detailName, detailTags, detailCustomFields, assignedArg);

      if (numberChanged) {
        // Row key changed across multiple tables — easiest correct path is a refetch.
        await loadContacts(true);
      } else {
        const newAssignedName = isAdmin
          ? (usersForAssign.find(u => u.id === Number(detailAssignedUserId))?.displayName ?? null)
          : detailAssignedUserName;
        setContacts(prev => prev.map(c =>
          c.contact_number === oldNumber
            ? { ...c, name: detailName || c.name, tags: detailTags, custom_fields: detailCustomFields,
                assigned_user_id: isAdmin ? (detailAssignedUserId == null ? null : Number(detailAssignedUserId)) : c.assigned_user_id,
                assigned_user_name: isAdmin ? newAssignedName : c.assigned_user_name }
            : c
        ));
      }
      setDetailContact(null);
    } catch (err) {
      notify('Failed to save: ' + err.message);
    } finally {
      setSavingDetail(false);
    }
  };

  const handleDeleteClick = (contact) => {
    setDeleteModal({ open: true, contact });
  };

  const handleDeleteConfirm = async () => {
    const contact = deleteModal.contact;
    if (!contact) return;
    try {
      await api.deleteContact(selectedNumber, contact.contact_number);
      setContacts(prev => prev.filter(c => c.contact_number !== contact.contact_number));
      setDeleteModal({ open: false, contact: null });
    } catch (err) {
      notify('Failed to remove contact: ' + err.message);
    }
  };

  const handleBulkDeleteConfirm = async () => {
    const numbers = [...selectedContacts];
    setBulkDeleteOpen(false);
    if (numbers.length === 0) return;
    const results = await Promise.allSettled(
      numbers.map(n => api.deleteContact(selectedNumber, n))
    );
    const removed = new Set();
    const failures = [];
    results.forEach((r, i) => {
      if (r.status === 'fulfilled') removed.add(numbers[i]);
      else failures.push({ n: numbers[i], err: r.reason });
    });
    if (removed.size > 0) {
      setContacts(prev => prev.filter(c => !removed.has(c.contact_number)));
      setSelectedContacts(prev => {
        const next = new Set(prev);
        removed.forEach(n => next.delete(n));
        return next;
      });
    }
    if (failures.length > 0) {
      notify(`Failed to remove ${failures.length} contact${failures.length === 1 ? '' : 's'}: ${failures[0].err?.message || 'unknown error'}`);
    }
  };

  const toggleTag = (tag) => {
    const exists = detailTags.find(t => t.id === tag.id);
    if (exists) {
      setDetailTags(prev => prev.filter(t => t.id !== tag.id));
    } else {
      // Only one tag per category: remove any other tag from the same category first
      setDetailTags(prev => [
        ...prev.filter(t => t.category_id !== tag.category_id),
        { id: tag.id, name: tag.name, color: tag.color, category_id: tag.category_id }
      ]);
    }
  };

  const filtered = contacts.filter(c => {
    const matchesSearch = !search ||
      c.contact_number.includes(search) ||
      (c.name && c.name.toLowerCase().includes(search.toLowerCase()));
    const matchesTag = filterTagIds.length === 0 || (c.tags || []).some(t => filterTagIds.includes(t.id));
    return matchesSearch && matchesTag;
  });

  const allSelected = filtered.length > 0 && filtered.every(c => selectedContacts.has(c.contact_number));
  const someSelected = filtered.some(c => selectedContacts.has(c.contact_number)) && !allSelected;

  const toggleSelectAll = () => {
    if (allSelected) {
      setSelectedContacts(prev => {
        const next = new Set(prev);
        filtered.forEach(c => next.delete(c.contact_number));
        return next;
      });
    } else {
      setSelectedContacts(prev => {
        const next = new Set(prev);
        filtered.forEach(c => next.add(c.contact_number));
        return next;
      });
    }
  };

  const toggleSelectOne = (contactNumber) => {
    setSelectedContacts(prev => {
      const next = new Set(prev);
      if (next.has(contactNumber)) next.delete(contactNumber);
      else next.add(contactNumber);
      return next;
    });
  };

  const clearSelection = () => setSelectedContacts(new Set());

  // ---- Import contacts ----
  const ACCEPTED_IMPORT = ['.csv', '.xlsx'];
  const isAcceptedSheet = (file) =>
    !!file && ACCEPTED_IMPORT.some(ext => file.name.toLowerCase().endsWith(ext));

  const openImport = () => {
    setImportFile(null);
    setImportResult(null);
    setImportError('');
    setImportModal(true);
  };
  const closeImport = () => {
    setImportModal(false);
    setImportFile(null);
    setImportResult(null);
    setImportError('');
  };
  const pickImportFile = (file) => {
    if (!file) return;
    if (!isAcceptedSheet(file)) {
      setImportError('Please choose a .csv or .xlsx file.');
      return;
    }
    setImportError('');
    setImportResult(null);
    setImportFile(file);
  };
  const runImport = async () => {
    if (!importFile || !selectedNumber) return;
    setImporting(true);
    setImportError('');
    try {
      const res = await api.importContacts(selectedNumber, importFile);
      setImportResult(res);
      loadContacts(true);
    } catch (err) {
      setImportError(err.message || 'Import failed. Please try again.');
    } finally {
      setImporting(false);
    }
  };
  // Ctrl+V paste a sheet straight into the open modal (universal paste support).
  useEffect(() => {
    if (!importModal) return;
    const onPaste = (e) => {
      const file = [...(e.clipboardData?.files || [])][0];
      if (file) { e.preventDefault(); pickImportFile(file); }
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, [importModal]);

  const selectedNumberName = numbers.find(n => n.wa_number === selectedNumber)?.display_name || maskPhone(selectedNumber);

  const getTagInfo = (tagRef) => tags.find(t => t.id === tagRef.id) || tagRef;

  // Extract template variables {{1}}, {{2}}, etc.
  const extractVars = (t) => {
    const m = [...(t || '').matchAll(/\{\{(\d+)\}\}/g)];
    return [...new Set(m.map(x => x[1]))].sort((a, b) => +a - +b);
  };

  // Resolve template variables using mapping + first selected contact for live preview
  const resolvePreviewText = (text, mapping, contact) => {
    if (!text || !contact) return text || '';
    return text.replace(/\{\{(\d+)\}\}/g, (_, v) => {
      const field = mapping[v];
      if (!field) return `{{${v}}}`;
      if (field === 'name') return contact.name || `{{${v}}}`;
      if (field === 'contact_number') return maskPhone(contact.contact_number) || `{{${v}}}`;
      if (field.startsWith('custom_fields.')) {
        const id = field.split('.')[1];
        return contact.custom_fields?.[id] || `{{${v}}}`;
      }
      if (field.startsWith('category_tag.')) {
        const catId = field.split('.')[1];
        const tag = contact.tags?.find(t => t.category_id == catId);
        return tag?.name || `{{${v}}}`;
      }
      return `{{${v}}}`;
    });
  };

  const selectedTemplate = templates.find(t => t.id.toString() === broadcastTemplateId);
  // WABA-scoped templates: a template only exists on the account it was approved
  // under, so sending it from a different number fails with Meta #132001. Scope
  // the picker to templates whose account phone matches the chosen "From" number.
  const eligibleTemplates = broadcastFrom
    ? templates.filter(t => String(t.whatsappAccountPhone || '').replace(/\D/g, '') === String(broadcastFrom).replace(/\D/g, ''))
    : [];
  // When the sending number changes, drop any selected template that isn't
  // approved on the new number so the send can't go out with a mismatched WABA.
  useEffect(() => {
    if (broadcastTemplateId && !eligibleTemplates.some(t => String(t.id) === String(broadcastTemplateId))) {
      setBroadcastTemplateId('');
      setBroadcastVariableMapping({});
      setBroadcastMediaLibraryId('');
    }
  }, [broadcastFrom]); // eslint-disable-line react-hooks/exhaustive-deps
  // 'image' | 'video' | 'document' when the selected template has a media header
  // (requires a header image at send time), else null.
  const headerMediaType = (() => {
    if (broadcastMessageType !== 'template' || !selectedTemplate) return null;
    const ht = String(selectedTemplate.header_type || '').toUpperCase();
    return ['IMAGE', 'VIDEO', 'DOCUMENT'].includes(ht) ? ht.toLowerCase() : null;
  })();
  const selectedRecipients = contacts.filter(c => selectedContacts.has(c.contact_number));
  const previewTemplate = selectedTemplate ? {
    ...selectedTemplate,
    body: resolvePreviewText(selectedTemplate.body, broadcastVariableMapping, selectedRecipients[0]),
    header_text: selectedTemplate.header_type === 'TEXT' ? resolvePreviewText(selectedTemplate.header_text, broadcastVariableMapping, selectedRecipients[0]) : selectedTemplate.header_text,
  } : null;

  const templateVars = useMemo(() => {
    if (!selectedTemplate) return [];
    const bodyVars = extractVars(selectedTemplate.body);
    const headerVars = selectedTemplate.header_type === 'TEXT' ? extractVars(selectedTemplate.header_text) : [];
    return [...new Set([...headerVars, ...bodyVars])].sort((a, b) => +a - +b);
  }, [selectedTemplate]);

  const isBroadcastFormInvalid = () => {
    if (!broadcastFrom || selectedRecipients.length === 0 || broadcasting) return true;
    if (broadcastMessageType === 'template' && !selectedTemplate) return true;
    if (broadcastMessageType === 'text' && !broadcastBody.trim()) return true;
    if (broadcastMessageType === 'link' && !broadcastUrl.trim()) return true;
    if (['image', 'video', 'audio', 'document'].includes(broadcastMessageType) && !broadcastMediaLibraryId) return true;
    if (headerMediaType && !broadcastMediaLibraryId) return true;
    return false;
  };

  // Actually send the broadcast (called after the user confirms in the modal).
  const runBroadcast = async () => {
    if (isBroadcastFormInvalid()) return;
    setBroadcasting(true);
    try {
      const payload = {
        from_number: broadcastFrom,
        recipient_numbers: selectedRecipients.map(r => ({ contact_number: r.contact_number, name: r.name })),
        status: 'SENT',
        test_number: testNumber || undefined,
        name: broadcastName.trim() || undefined,
        message_type: broadcastMessageType,
      };
      if (broadcastMessageType === 'template') {
        payload.template_id = selectedTemplate.id;
        payload.variable_mapping = broadcastVariableMapping;
        if (headerMediaType && broadcastMediaLibraryId) payload.media_library_id = Number(broadcastMediaLibraryId);
      } else if (broadcastMessageType === 'text') {
        payload.body = broadcastBody;
      } else if (broadcastMessageType === 'link') {
        payload.url = broadcastUrl;
      } else if (['image', 'video', 'audio', 'document'].includes(broadcastMessageType)) {
        payload.media_library_id = Number(broadcastMediaLibraryId);
        payload.caption = broadcastCaption || undefined;
      }
      const broadcast = await api.broadcasts.create(payload);
      await api.broadcasts.send(broadcast.id);
      notify(`Broadcast sent to ${selectedRecipients.length} contact(s) from ${broadcastFrom}!`);
      setBroadcastModal(false);
      setBroadcastTemplateId('');
      setBroadcastName('');
      setTestNumber('');
      setBroadcastFrom('');
      setBroadcastMessageType('template');
      setBroadcastBody('');
      setBroadcastUrl('');
      setBroadcastMediaLibraryId('');
      setBroadcastMediaItems([]);
      setBroadcastCaption('');
      clearSelection();
    } catch (err) {
      notify('Broadcast failed: ' + err.message);
    } finally {
      setBroadcasting(false);
    }
  };

  // Load media items for media-type broadcasts OR for a template with a media
  // header (IMAGE/VIDEO/DOCUMENT) — both need a Media Library pick.
  useEffect(() => {
    const mediaTypes = ['image', 'video', 'audio', 'document'];
    let neededType = null;
    if (mediaTypes.includes(broadcastMessageType)) {
      neededType = broadcastMessageType;
    } else if (broadcastMessageType === 'template') {
      const tpl = templates.find(t => t.id.toString() === broadcastTemplateId);
      const ht = String(tpl?.header_type || '').toLowerCase();
      if (['image', 'video', 'document'].includes(ht)) neededType = ht;
    }
    if (!neededType) {
      setBroadcastMediaItems([]);
      setBroadcastMediaLibraryId('');
      return;
    }
    setBroadcastMediaLoading(true);
    api.mediaLibrary.list()
      .then(res => {
        const filtered = (res.media || []).filter(m => m.mediaType === neededType);
        setBroadcastMediaItems(filtered);
      })
      .catch(() => setBroadcastMediaItems([]))
      .finally(() => setBroadcastMediaLoading(false));
  }, [broadcastMessageType, broadcastTemplateId, templates]);

  // Available contact fields for variable mapping
  const contactFieldOptions = useMemo(() => {
    const opts = [
      { value: 'name', label: 'Contact Name' },
      { value: 'contact_number', label: 'Phone Number' },
    ];
    categories.forEach(cat => {
      opts.push({ value: `category_tag.${cat.id}`, label: cat.name });
    });
    contactFields.forEach(f => {
      opts.push({ value: `custom_fields.${f.id}`, label: f.name });
    });
    return opts;
  }, [categories, contactFields]);

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      {/* Header */}
      <div style={{
        padding: '20px 24px',
        borderBottom: `1px solid ${C.border}`,
        background: C.cardBg,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 16 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <Users size={22} color={C.text} />
            <div>
              <h1 style={{ fontSize: 22, fontWeight: 700, color: C.text, margin: 0, letterSpacing: '-.02em', fontFamily: FONT }}>Contacts</h1>
              <p style={{ fontSize: 12, color: C.textMuted, margin: '4px 0 0', fontFamily: FONT }}>
                {contacts.length} saved contact{contacts.length !== 1 ? 's' : ''}
              </p>
            </div>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <button
              onClick={openImport}
              disabled={!selectedNumber}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 6,
                padding: '8px 14px', borderRadius: 8,
                border: `1px solid ${C.border}`, background: C.cardBg,
                cursor: selectedNumber ? 'pointer' : 'not-allowed',
                fontSize: 13, fontWeight: 700, color: C.text, fontFamily: FONT,
                opacity: selectedNumber ? 1 : 0.5,
              }}
              onMouseEnter={e => { if (selectedNumber) e.currentTarget.style.background = 'var(--c-chatPanel)'; }}
              onMouseLeave={e => { e.currentTarget.style.background = C.cardBg; }}
            >
              <Upload size={15} /> Import
            </button>

            <SearchableSelect
              value={selectedNumber || ''}
              onChange={(val) => setSelectedNumber(val)}
              options={numbers.map(n => ({ value: n.wa_number, label: n.display_name || maskPhone(n.wa_number) }))}
              placeholder="No WhatsApp number"
              searchPlaceholder="Search numbers..."
              disabled={numbers.length === 0}
              style={{ minWidth: 200 }}
              triggerStyle={{ padding: '8px 32px 8px 12px', border: `1px solid ${C.border}` }}
            />
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 16, flexWrap: 'wrap' }}>
          <div style={{
            display: 'flex', alignItems: 'center', gap: 10,
            background: 'var(--c-chatPanel)', borderRadius: 8,
            padding: '8px 12px', flex: 1, minWidth: 200, maxWidth: 400,
          }}>
            <Search size={16} color={C.textMuted} />
            <input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search contacts..."
              style={{
                flex: 1, border: 'none', background: 'transparent',
                fontSize: 14, fontFamily: FONT, outline: 'none', color: C.text,
              }}
            />
          </div>

          <TagMultiSelect
            categories={categories}
            tags={tags}
            selectedIds={filterTagIds}
            onChange={setFilterTagIds}
            minWidth={180}
          />

          <button
            onClick={() => {
              if (selectedContacts.size > 0) {
                setBroadcastModal(true);
                api.templates.list().catch(() => []).then(data => {
                  setTemplates(data.filter(t => t.status === 'APPROVED'));
                });
              }
            }}
            style={{
              display: 'flex', alignItems: 'center', gap: 4,
              padding: '8px 14px', borderRadius: 8,
              border: 'none',
              background: selectedContacts.size > 0 ? C.primary : '#ccc',
              cursor: selectedContacts.size > 0 ? 'pointer' : 'not-allowed',
              fontSize: 13, fontWeight: 700,
              color: '#fff', fontFamily: FONT,
            }}
          >
            <Send size={14} /> Broadcast
          </button>
          {selectedContacts.size > 0 && (
            <>
              {isAdmin && (
              <button
                onClick={() => setBulkDeleteOpen(true)}
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: 6,
                  padding: '8px 14px', borderRadius: 8,
                  border: `1.5px solid ${C.primary}`, background: C.primaryLight,
                  cursor: 'pointer', fontSize: 13, fontWeight: 700,
                  color: C.primary, fontFamily: FONT,
                }}
                onMouseEnter={e => { e.currentTarget.style.background = C.primary; e.currentTarget.style.color = '#fff'; }}
                onMouseLeave={e => { e.currentTarget.style.background = C.primaryLight; e.currentTarget.style.color = C.primary; }}
              >
                <Trash2 size={14} /> Delete {selectedContacts.size} selected
              </button>
              )}
              <button
                onClick={clearSelection}
                style={{
                  display: 'flex', alignItems: 'center', gap: 4,
                  padding: '8px 12px', borderRadius: 8,
                  border: `1px solid ${C.border}`, background: 'var(--c-cardBg)',
                  cursor: 'pointer', fontSize: 12, fontWeight: 600,
                  color: C.textSecondary, fontFamily: FONT,
                }}
              >
                <X size={12} /> Clear selection
              </button>
            </>
          )}
          {(search || filterTagIds.length > 0) && (
            <button
              onClick={() => { setSearch(''); setFilterTagIds([]); }}
              style={{
                display: 'flex', alignItems: 'center', gap: 4,
                padding: '8px 12px', borderRadius: 8,
                border: `1px solid ${C.border}`, background: 'var(--c-cardBg)',
                cursor: 'pointer', fontSize: 12, fontWeight: 600,
                color: C.textSecondary, fontFamily: FONT,
              }}
            >
              <X size={12} /> Clear
            </button>
          )}
        </div>
      </div>

      {/* Contact table */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '16px 24px' }}>
        {loading && contacts.length === 0 && (
          <div style={{ textAlign: 'center', color: C.textMuted, fontSize: 13, padding: 40 }}>
            <Loader2 size={20} style={{ animation: 'spin 1s linear infinite', margin: '0 auto 8px' }} />
            Loading contacts...
          </div>
        )}

        {!loading && filtered.length === 0 && (
          <div style={{ textAlign: 'center', color: C.textMuted, fontSize: 13, padding: 60 }}>
            <User size={40} style={{ margin: '0 auto 12px', opacity: 0.4 }} />
            <div>{(search || filterTagIds.length > 0) ? 'No contacts match your filters' : 'No saved contacts yet'}</div>
            {!search && (
              <div style={{ marginTop: 6, fontSize: 12 }}>
                Open a chat and click the edit icon next to a contact name to save it here.
              </div>
            )}
          </div>
        )}

        {filtered.length > 0 && (
          <div style={{ border: `1px solid ${C.border}`, borderRadius: 10, overflow: 'hidden' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: FONT, fontSize: 13 }}>
              <thead>
                <tr style={{ background: 'var(--c-hover)' }}>
                  <th style={{ padding: '12px 8px 12px 16px', textAlign: 'center', fontWeight: 600, color: C.textSecondary, borderBottom: `1px solid ${C.border}`, width: 40 }}>
                    <input
                      type="checkbox"
                      checked={allSelected}
                      ref={el => { if (el) el.indeterminate = someSelected; }}
                      onChange={toggleSelectAll}
                      style={{ cursor: 'pointer', width: 16, height: 16 }}
                    />
                  </th>
                  <th style={{ padding: '12px 16px', textAlign: 'left', fontWeight: 600, color: C.textSecondary, borderBottom: `1px solid ${C.border}` }}>Name</th>
                  <th style={{ padding: '12px 16px', textAlign: 'left', fontWeight: 600, color: C.textSecondary, borderBottom: `1px solid ${C.border}` }}>Phone</th>
                  {isAdmin && (
                    <th style={{ padding: '12px 16px', textAlign: 'left', fontWeight: 600, color: C.textSecondary, borderBottom: `1px solid ${C.border}` }}>Assigned to</th>
                  )}
                  {categories.map(cat => (
                    <th key={cat.id} style={{ padding: '12px 16px', textAlign: 'left', fontWeight: 600, color: C.textSecondary, borderBottom: `1px solid ${C.border}` }}>{cat.name}</th>
                  ))}
                  <th style={{ padding: '12px 16px', textAlign: 'right', fontWeight: 600, color: C.textSecondary, borderBottom: `1px solid ${C.border}` }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map(c => {
                  const isSelected = selectedContacts.has(c.contact_number);
                  return (
                    <tr key={c.contact_number} style={{ background: isSelected ? 'var(--c-primaryLight)' : 'var(--c-cardBg)', borderBottom: `1px solid ${C.border}`, cursor: 'pointer' }}
                      onClick={() => openDetail(c, 'view')}
                      onMouseEnter={e => { if (!isSelected) e.currentTarget.style.background = '#f9fafb'; }}
                      onMouseLeave={e => { if (!isSelected) e.currentTarget.style.background = '#fff'; }}
                    >
                      <td style={{ padding: '12px 8px 12px 16px', textAlign: 'center' }} onClick={e => e.stopPropagation()}>
                        <input
                          type="checkbox"
                          checked={isSelected}
                          onChange={() => toggleSelectOne(c.contact_number)}
                          style={{ cursor: 'pointer', width: 16, height: 16 }}
                        />
                      </td>
                      <td style={{ padding: '12px 16px', fontWeight: 600, color: C.text }}>{c.name}</td>
                      <td style={{ padding: '12px 16px', color: C.textSecondary }}><MaskedNumber number={c.contact_number} prefix="+" /></td>
                      {isAdmin && (
                        <td style={{ padding: '12px 16px' }}>
                          {c.assigned_user_name || c.assigned_user_id ? (
                            <span style={{
                              display: 'inline-flex', alignItems: 'center', gap: 4,
                              padding: '3px 8px', borderRadius: 999,
                              background: '#E5F2EE', color: '#0F6E56',
                              border: '1px solid #B8DCCF',
                              fontSize: 11, fontWeight: 700,
                              fontFamily: FONT,
                            }}>
                              {c.assigned_user_name || `user ${c.assigned_user_id}`}
                            </span>
                          ) : (
                            <span style={{ color: C.textMuted, fontSize: 12, fontStyle: 'italic' }}>Unassigned</span>
                          )}
                        </td>
                      )}
                      {categories.map(cat => {
                        const tag = (c.tags || []).find(t => t.category_id === cat.id);
                        const info = tag ? getTagInfo(tag) : null;
                        return (
                          <td key={cat.id} style={{ padding: '12px 16px' }}>
                            {info ? <TagBadge tag={info} /> : <span style={{ color: C.textMuted, fontSize: 12 }}>—</span>}
                          </td>
                        );
                      })}
                      <td style={{ padding: '12px 16px', textAlign: 'right' }}>
                        <button onClick={(e) => { e.stopPropagation(); openDetail(c, 'edit'); }} style={{
                          border: 'none', background: 'transparent', cursor: 'pointer',
                          color: C.primary, fontSize: 12, fontWeight: 600, marginRight: 12,
                        }}>
                          <Pencil size={14} style={{ verticalAlign: 'middle', marginRight: 4 }} />Edit
                        </button>
                        {isAdmin && (
                        <button onClick={(e) => { e.stopPropagation(); handleDeleteClick(c); }} style={{
                          border: 'none', background: 'transparent', cursor: 'pointer',
                          color: C.primary, fontSize: 12, fontWeight: 600,
                        }}>Delete</button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Import Contacts Modal */}
      {importModal && (
        <div
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.35)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 200, padding: 20 }}
          onClick={closeImport}
        >
          <div
            onClick={e => e.stopPropagation()}
            style={{ background: C.cardBg, borderRadius: 14, boxShadow: C.shadowLg, width: '100%', maxWidth: 520, maxHeight: '90vh', overflowY: 'auto', fontFamily: FONT }}
          >
            <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
            {/* Header */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '18px 22px', borderBottom: `1px solid ${C.border}` }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <Upload size={18} color={C.primary} />
                <h2 style={{ fontSize: 17, fontWeight: 700, color: C.text, margin: 0 }}>Import Contacts</h2>
              </div>
              <button onClick={closeImport} style={{ border: 'none', background: 'transparent', cursor: 'pointer', color: C.textMuted, display: 'flex', padding: 4 }}>
                <X size={18} />
              </button>
            </div>

            <div style={{ padding: '20px 22px' }}>
              <p style={{ fontSize: 13, color: C.textSecondary, margin: '0 0 18px', lineHeight: 1.5 }}>
                Add contacts to <strong style={{ color: C.text }}>{selectedNumberName}</strong>. Upload a sheet with
                {' '}<strong style={{ color: C.text }}>Name</strong> and <strong style={{ color: C.text }}>Phone Number</strong> columns
                (include the country code, e.g. <span style={{ fontFamily: 'monospace' }}>919876543210</span>).
              </p>

              {importResult ? (
                /* ---- Result summary ---- */
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14 }}>
                    <CheckCircle2 size={20} color={C.green} />
                    <span style={{ fontSize: 15, fontWeight: 700, color: C.text }}>Import complete</span>
                  </div>
                  <div style={{ display: 'flex', gap: 10, marginBottom: importResult.skipped?.length ? 16 : 0 }}>
                    {[
                      { label: 'Added', value: importResult.imported, color: C.green },
                      { label: 'Updated', value: importResult.updated, color: C.purple },
                      { label: 'Skipped', value: importResult.skipped?.length || 0, color: importResult.skipped?.length ? C.primary : C.textMuted },
                    ].map(s => (
                      <div key={s.label} style={{ flex: 1, border: `1px solid ${C.border}`, borderRadius: 10, padding: '12px 14px', textAlign: 'center' }}>
                        <div style={{ fontSize: 24, fontWeight: 700, color: s.color, fontFamily: 'monospace' }}>{s.value}</div>
                        <div style={{ fontSize: 11, color: C.textMuted, textTransform: 'uppercase', letterSpacing: '0.04em', marginTop: 2 }}>{s.label}</div>
                      </div>
                    ))}
                  </div>
                  {importResult.skipped?.length > 0 && (
                    <div style={{ background: '#FFF8E6', border: '1px solid #F0E0B0', borderRadius: 10, padding: '10px 14px', maxHeight: 160, overflowY: 'auto' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 700, color: '#8A6D00', marginBottom: 6 }}>
                        <AlertTriangle size={14} /> Skipped rows
                      </div>
                      {importResult.skipped.map((s, i) => (
                        <div key={i} style={{ fontSize: 12, color: '#7A6200', padding: '2px 0' }}>
                          Row {s.row}: {s.reason}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ) : (
                /* ---- Upload step ---- */
                <>
                  <a
                    href={api.importContactsTemplateUrl()}
                    download
                    style={{
                      display: 'inline-flex', alignItems: 'center', gap: 8,
                      padding: '9px 14px', borderRadius: 8, marginBottom: 16,
                      border: `1px solid ${C.border}`, background: 'var(--c-chatPanel)',
                      cursor: 'pointer', fontSize: 13, fontWeight: 600, color: C.text,
                      textDecoration: 'none',
                    }}
                  >
                    <Download size={15} color={C.primary} /> Download sample sheet
                  </a>

                  <label
                    onDragOver={e => { e.preventDefault(); }}
                    onDrop={e => { e.preventDefault(); pickImportFile([...(e.dataTransfer?.files || [])][0]); }}
                    style={{
                      display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 8,
                      border: `2px dashed ${importFile ? C.green : C.border}`, borderRadius: 12,
                      padding: '28px 20px', cursor: 'pointer', textAlign: 'center',
                      background: importFile ? 'rgba(15,110,86,0.05)' : 'transparent',
                    }}
                  >
                    <input
                      type="file"
                      accept=".csv,.xlsx"
                      style={{ display: 'none' }}
                      onChange={e => pickImportFile(e.target.files?.[0])}
                    />
                    {importFile ? (
                      <>
                        <FileSpreadsheet size={26} color={C.green} />
                        <span style={{ fontSize: 14, fontWeight: 700, color: C.text }}>{importFile.name}</span>
                        <span style={{ fontSize: 12, color: C.textMuted }}>Click to choose a different file</span>
                      </>
                    ) : (
                      <>
                        <FileSpreadsheet size={26} color={C.textMuted} />
                        <span style={{ fontSize: 14, fontWeight: 600, color: C.text }}>Click to upload, drag a file here, or paste (Ctrl+V)</span>
                        <span style={{ fontSize: 12, color: C.textMuted }}>Accepts .csv and .xlsx</span>
                      </>
                    )}
                  </label>
                </>
              )}

              {importError && (
                <div style={{ marginTop: 14, background: '#FCEBEB', color: '#A32D2D', borderRadius: 8, padding: '10px 14px', fontSize: 13 }}>
                  {importError}
                </div>
              )}
            </div>

            {/* Footer */}
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, padding: '14px 22px', borderTop: `1px solid ${C.border}` }}>
              {importResult ? (
                <button
                  onClick={closeImport}
                  style={{ padding: '9px 20px', borderRadius: 8, border: 'none', background: C.primary, color: '#fff', cursor: 'pointer', fontSize: 13, fontWeight: 700, fontFamily: FONT }}
                >
                  Done
                </button>
              ) : (
                <>
                  <button
                    onClick={closeImport}
                    style={{ padding: '9px 18px', borderRadius: 8, border: `1px solid ${C.border}`, background: C.cardBg, color: C.textSecondary, cursor: 'pointer', fontSize: 13, fontWeight: 600, fontFamily: FONT }}
                  >
                    Cancel
                  </button>
                  <button
                    onClick={runImport}
                    disabled={!importFile || importing}
                    style={{
                      display: 'inline-flex', alignItems: 'center', gap: 6,
                      padding: '9px 20px', borderRadius: 8, border: 'none',
                      background: (!importFile || importing) ? '#ccc' : C.primary, color: '#fff',
                      cursor: (!importFile || importing) ? 'not-allowed' : 'pointer',
                      fontSize: 13, fontWeight: 700, fontFamily: FONT,
                    }}
                  >
                    {importing ? <><Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} /> Importing…</> : <>Import contacts</>}
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Delete Confirm Modal */}
      <DeleteConfirmModal
        open={deleteModal.open}
        title="Remove Contact"
        message={deleteModal.contact ? `Are you sure you want to remove "${deleteModal.contact.name}" from saved contacts?` : ''}
        confirmText="Remove"
        onConfirm={handleDeleteConfirm}
        onCancel={() => setDeleteModal({ open: false, contact: null })}
      />

      {/* Bulk Delete Confirm Modal */}
      <DeleteConfirmModal
        open={bulkDeleteOpen}
        title={`Remove ${selectedContacts.size} contact${selectedContacts.size === 1 ? '' : 's'}`}
        message={`Are you sure you want to remove ${selectedContacts.size} contact${selectedContacts.size === 1 ? '' : 's'} from saved contacts? This cannot be undone.`}
        confirmText="Remove"
        onConfirm={handleBulkDeleteConfirm}
        onCancel={() => setBulkDeleteOpen(false)}
      />

      {/* Broadcast Modal */}
      {broadcastModal && (
        <div style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,.35)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          zIndex: 200, fontFamily: FONT,
        }}>
          <div style={{
            background: C.cardBg, borderRadius: 14,
            width: 900, maxHeight: '90vh',
            boxShadow: C.shadowLg, overflowY: 'auto',
            display: 'flex', flexDirection: 'column',
          }}>
            {/* Modal Header */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '20px 24px 0' }}>
              <div style={{ fontSize: 18, fontWeight: 700, color: C.text }}>
                <Send size={18} style={{ display: 'inline', verticalAlign: 'text-bottom', marginRight: 8, color: C.primary }} />
                Broadcast Message
              </div>
              <button onClick={() => { setBroadcastModal(false); setBroadcastMessage(''); setBroadcastTemplateId(''); setBroadcastName(''); setTestNumber(''); setBroadcastMessageType('template'); setBroadcastBody(''); setBroadcastUrl(''); setBroadcastMediaLibraryId(''); setBroadcastMediaItems([]); setBroadcastCaption(''); setBroadcastMediaLoading(false); }} style={{
                border: 'none', background: 'transparent', cursor: 'pointer', color: C.textMuted,
              }}><X size={20} /></button>
            </div>

            {/* Two-column body */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 420px', gap: 24, padding: '20px 24px' }}>
              {/* LEFT — Form */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>

                {/* Broadcast Name */}
                <div>
                  <div style={{ fontSize: 12, fontWeight: 700, color: C.textSecondary, marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Broadcast Name</div>
                  <input
                    type="text"
                    value={broadcastName}
                    onChange={e => setBroadcastName(e.target.value)}
                    placeholder="e.g. April Fee Reminder"
                    style={{
                      width: '100%', padding: '10px 12px', borderRadius: 8,
                      border: `1.5px solid ${C.border}`, fontSize: 13,
                      fontFamily: FONT, color: C.text, outline: 'none',
                      boxSizing: 'border-box',
                    }}
                  />
                </div>

                {/* From */}
                <div>
                  <div style={{ fontSize: 12, fontWeight: 700, color: C.textSecondary, marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.06em' }}>From (Team Member Number)</div>
                  <SearchableSelect
                    value={broadcastFrom}
                    onChange={(val) => setBroadcastFrom(val)}
                    options={numbers.map(n => ({ value: n.wa_number, label: n.display_name || maskPhone(n.wa_number) }))}
                    placeholder="Select team member number..."
                    searchPlaceholder="Search numbers..."
                  />
                </div>

                {/* To */}
                <div>
                  <div style={{ fontSize: 12, fontWeight: 700, color: C.textSecondary, marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.06em' }}>To ({selectedRecipients.length} selected)</div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, maxHeight: 100, overflowY: 'auto', padding: '10px 12px', background: 'var(--c-hover)', borderRadius: 8, border: `1.5px solid ${C.border}` }}>
                    {selectedRecipients.map(c => (
                      <span key={c.contact_number} style={{ fontSize: 11, color: C.textSecondary, background: 'var(--c-cardBg)', padding: '3px 10px', borderRadius: 99, border: `1px solid ${C.border}`, fontFamily: FONT, fontWeight: 500 }}>
                        {c.name} (<MaskedNumber number={c.contact_number} prefix="+" />)
                      </span>
                    ))}
                  </div>
                </div>

                {/* Message Type */}
                <div>
                  <div style={{ fontSize: 12, fontWeight: 700, color: C.textSecondary, marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Message Type</div>
                  <SearchableSelect
                    value={broadcastMessageType}
                    onChange={(val) => setBroadcastMessageType(val)}
                    options={[
                      { value: 'template', label: 'Template Message' },
                      { value: 'text', label: 'Text Message' },
                      { value: 'link', label: 'Link Message' },
                      { value: 'image', label: 'Image Message' },
                      { value: 'video', label: 'Video Message' },
                      { value: 'audio', label: 'Audio Message' },
                      { value: 'document', label: 'Document Message' },
                    ]}
                  />
                </div>

                {/* Template Fields */}
                {broadcastMessageType === 'template' && (
                  <>
                    <div>
                      <div style={{ fontSize: 12, fontWeight: 700, color: C.textSecondary, marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Message Template</div>
                      <SearchableSelect
                        value={broadcastTemplateId}
                        onChange={(val) => { setBroadcastTemplateId(val); setBroadcastVariableMapping({}); setBroadcastMediaLibraryId(''); }}
                        options={eligibleTemplates.map(t => ({ value: String(t.id), label: `${t.name} (${t.category})`, sublabel: t.language || t.lang || '' }))}
                        placeholder="Select a template..."
                        searchPlaceholder="Search templates..."
                        emptyText={broadcastFrom ? 'No approved templates on this number' : 'Select a sending number first'}
                        createLabel="Create new template"
                        onCreate={() => onNavigate?.('template-builder', 'new')}
                      />
                      {!broadcastFrom ? (
                        <div style={{ fontSize: 11, color: C.textMuted, marginTop: 4, fontFamily: FONT }}>Pick a sending number above to see its approved templates.</div>
                      ) : eligibleTemplates.length === 0 && (
                        <div style={{ fontSize: 11, color: C.textMuted, marginTop: 4, fontFamily: FONT }}>No approved templates on this number. Templates are tied to the WhatsApp account they were approved on.</div>
                      )}
                    </div>

                    {/* Header media — required for IMAGE/VIDEO/DOCUMENT header templates */}
                    {headerMediaType && (
                      <div>
                        <div style={{ fontSize: 12, fontWeight: 700, color: C.textSecondary, marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                          Header {headerMediaType} <span style={{ color: C.primary }}>*</span>
                        </div>
                        <SearchableSelect
                          value={broadcastMediaLibraryId}
                          onChange={(val) => setBroadcastMediaLibraryId(val)}
                          disabled={broadcastMediaLoading}
                          options={broadcastMediaItems.map(m => ({ value: String(m.id), label: m.name || m.originalName || `Media #${m.id}` }))}
                          placeholder={broadcastMediaLoading ? 'Loading...' : `— Select ${headerMediaType} —`}
                          searchPlaceholder="Search media..."
                        />
                        {broadcastMediaItems.length === 0 && !broadcastMediaLoading ? (
                          <div style={{ fontSize: 11, color: '#E65100', marginTop: 4, fontFamily: FONT }}>
                            This template has a {headerMediaType} header — upload a {headerMediaType} to the Media Library first.
                          </div>
                        ) : (
                          <div style={{ fontSize: 11, color: C.textMuted, marginTop: 4, fontFamily: FONT }}>
                            This template has a {headerMediaType} header — pick the {headerMediaType} to send in the header.
                          </div>
                        )}
                        {broadcastMediaLibraryId && headerMediaType === 'image' && (
                          <img
                            src={api.mediaLibrary.downloadUrl(Number(broadcastMediaLibraryId))}
                            alt=""
                            style={{ marginTop: 8, width: '100%', maxHeight: 140, objectFit: 'cover', borderRadius: 8, border: `1px solid ${C.border}`, display: 'block' }}
                          />
                        )}
                      </div>
                    )}

                    {templateVars.length > 0 && (
                      <div>
                        <div style={{ fontSize: 12, fontWeight: 700, color: C.textSecondary, marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Variable Mapping</div>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                          {templateVars.map(v => (
                            <div key={v} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                              <span style={{ fontSize: 12, fontWeight: 600, color: C.text, fontFamily: "'DM Mono', monospace", background: 'var(--c-hover)', padding: '4px 8px', borderRadius: 4, whiteSpace: 'nowrap' }}>{'{{' + v + '}}'}</span>
                              <span style={{ fontSize: 12, color: C.textMuted }}>→</span>
                              <SearchableSelect
                                value={broadcastVariableMapping[v] || ''}
                                onChange={(val) => setBroadcastVariableMapping(prev => ({ ...prev, [v]: val }))}
                                options={contactFieldOptions}
                                placeholder="Select contact field..."
                                searchPlaceholder="Search fields..."
                                style={{ flex: 1 }}
                                triggerStyle={{ padding: '8px 28px 8px 10px', borderRadius: 6, fontSize: 12 }}
                              />
                            </div>
                          ))}
                        </div>
                        <div style={{ fontSize: 11, color: C.textMuted, marginTop: 6, fontFamily: FONT }}>
                          Map each template variable to a contact field. Values will be pulled per recipient when sending.
                        </div>
                      </div>
                    )}
                  </>
                )}

                {/* Text Fields */}
                {broadcastMessageType === 'text' && (
                  <div>
                    <div style={{ fontSize: 12, fontWeight: 700, color: C.textSecondary, marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Message Text</div>
                    <textarea
                      value={broadcastBody}
                      onChange={e => setBroadcastBody(e.target.value)}
                      placeholder="Type your message here..."
                      rows={4}
                      style={{
                        width: '100%', padding: '10px 12px', borderRadius: 8,
                        border: `1.5px solid ${C.border}`, fontSize: 13,
                        fontFamily: FONT, color: C.text, outline: 'none',
                        boxSizing: 'border-box', resize: 'vertical',
                      }}
                    />
                    <div style={{ fontSize: 11, color: C.textMuted, marginTop: 4, fontFamily: FONT }}>
                      Use {'{{name}}'} and {'{{contact_number}}'} for dynamic values per recipient.
                    </div>
                  </div>
                )}

                {/* Link Fields */}
                {broadcastMessageType === 'link' && (
                  <div>
                    <div style={{ fontSize: 12, fontWeight: 700, color: C.textSecondary, marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Link URL</div>
                    <input
                      type="text"
                      value={broadcastUrl}
                      onChange={e => setBroadcastUrl(e.target.value)}
                      placeholder="https://example.com"
                      style={{
                        width: '100%', padding: '10px 12px', borderRadius: 8,
                        border: `1.5px solid ${C.border}`, fontSize: 13,
                        fontFamily: FONT, color: C.text, outline: 'none',
                        boxSizing: 'border-box',
                      }}
                    />
                    <div style={{ fontSize: 11, color: C.textMuted, marginTop: 4, fontFamily: FONT }}>
                      The link will be sent as a text message with preview enabled.
                    </div>
                  </div>
                )}

                {/* Media Fields */}
                {['image', 'video', 'audio', 'document'].includes(broadcastMessageType) && (
                  <>
                    <div>
                      <div style={{ fontSize: 12, fontWeight: 700, color: C.textSecondary, marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Select from Media Library</div>
                      <SearchableSelect
                        value={broadcastMediaLibraryId}
                        onChange={(val) => setBroadcastMediaLibraryId(val)}
                        disabled={broadcastMediaLoading}
                        options={broadcastMediaItems.map(m => ({ value: String(m.id), label: m.name || m.originalName || `Media #${m.id}` }))}
                        placeholder={broadcastMediaLoading ? 'Loading...' : `— Select ${broadcastMessageType} —`}
                        searchPlaceholder="Search media..."
                      />
                      {broadcastMediaItems.length === 0 && !broadcastMediaLoading && (
                        <div style={{ fontSize: 11, color: C.textMuted, marginTop: 4, fontFamily: FONT }}>
                          No {broadcastMessageType}s in the Media Library. Upload one from the Media tab first.
                        </div>
                      )}
                    </div>

                    {broadcastMediaLibraryId && (
                      <div style={{ borderRadius: 10, overflow: 'hidden', border: `1px solid ${C.border}`, background: 'var(--c-hover)' }}>
                        {broadcastMessageType === 'image' ? (
                          <img
                            src={api.mediaLibrary.downloadUrl(Number(broadcastMediaLibraryId))}
                            alt=""
                            style={{ width: '100%', height: 140, objectFit: 'cover', display: 'block' }}
                          />
                        ) : broadcastMessageType === 'video' ? (
                          <div style={{ position: 'relative', width: '100%', height: 140 }}>
                            <video
                              src={api.mediaLibrary.downloadUrl(Number(broadcastMediaLibraryId))}
                              style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                              preload="metadata"
                              muted
                            />
                            <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,0.25)' }}>
                              <div style={{ width: 40, height: 40, borderRadius: '50%', background: 'rgba(255,255,255,0.9)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                                <Play size={16} color="#111" fill="#111" />
                              </div>
                            </div>
                          </div>
                        ) : (
                          <div style={{ padding: 16, display: 'flex', alignItems: 'center', gap: 12 }}>
                            <div style={{ width: 40, height: 40, borderRadius: 8, background: '#E1F5EE', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#0F6E56' }}>
                              {broadcastMessageType === 'audio' ? <Music size={20} /> : <FileText size={20} />}
                            </div>
                            <div>
                              <div style={{ fontSize: 12, fontWeight: 600, color: C.text, fontFamily: FONT }}>
                                {broadcastMediaItems.find(m => String(m.id) === String(broadcastMediaLibraryId))?.name || 'Media'}
                              </div>
                              <div style={{ fontSize: 11, color: C.textMuted, fontFamily: FONT, textTransform: 'capitalize' }}>
                                {broadcastMessageType}
                              </div>
                            </div>
                          </div>
                        )}
                      </div>
                    )}

                    {broadcastMessageType !== 'audio' && (
                      <div>
                        <div style={{ fontSize: 12, fontWeight: 700, color: C.textSecondary, marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Caption (optional)</div>
                        <input
                          type="text"
                          value={broadcastCaption}
                          onChange={e => setBroadcastCaption(e.target.value)}
                          placeholder="Optional caption..."
                          style={{
                            width: '100%', padding: '10px 12px', borderRadius: 8,
                            border: `1.5px solid ${C.border}`, fontSize: 13,
                            fontFamily: FONT, color: C.text, outline: 'none',
                            boxSizing: 'border-box',
                          }}
                        />
                      </div>
                    )}
                  </>
                )}

                {/* Test Number */}
                <div>
                  <div style={{ fontSize: 12, fontWeight: 700, color: C.textSecondary, marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Test Number</div>
                  <div style={{ display: 'flex', gap: 8 }}>
                    {/* Searchable Dropdown */}
                    <div ref={testNumRef} style={{ flex: 1, position: 'relative' }}>
                      <input
                        value={testNumber}
                        onChange={e => { setTestNumber(e.target.value); if (!testNumberOpen) setTestNumberOpen(true); }}
                        onFocus={() => setTestNumberOpen(true)}
                        placeholder="Type any number or pick a contact…"
                        inputMode="tel"
                        style={{
                          width: '100%', padding: '10px 32px 10px 12px', borderRadius: 8,
                          border: `1.5px solid ${C.border}`, fontSize: 13, fontFamily: FONT,
                          color: C.text, background: 'var(--c-cardBg)', outline: 'none', boxSizing: 'border-box',
                        }}
                      />
                      <ChevronDown size={14} color={C.textMuted} onClick={() => setTestNumberOpen(o => !o)} style={{ position: 'absolute', right: 10, top: '50%', transform: `translateY(-50%) ${testNumberOpen ? 'rotate(180deg)' : ''}`, cursor: 'pointer' }} />
                      {testNumberOpen && (() => {
                        const q = (testNumber || '').toLowerCase().trim();
                        const qDigits = q.replace(/\D/g, '');
                        const fromNum = (broadcastFrom || '').replace(/\D/g, '');
                        // Guard the digit check with `qDigits &&` — "".includes("") is
                        // always true, which otherwise makes a name search match every row.
                        const matchNum = (num) => num && num !== fromNum;
                        const matchQ = (num, name) => !q || (qDigits && num.includes(qDigits)) || (name || '').toLowerCase().includes(q);
                        const allContacts = contacts.filter(c => {
                          const num = (c.contact_number || '').replace(/\D/g, '');
                          return matchNum(num) && matchQ(num, c.name);
                        });
                        const allMembers = teamMembers.filter(tm => {
                          const num = (tm.phone_number || '').replace(/\D/g, '');
                          return matchNum(num) && matchQ(num, tm.name);
                        });
                        const CAP = 50;
                        const contactSugs = allContacts.slice(0, CAP);
                        const memberSugs = allMembers.slice(0, CAP);
                        const hiddenCount = (allContacts.length - contactSugs.length) + (allMembers.length - memberSugs.length);
                        const pick = (number) => { setTestNumber(String(number || '').replace(/\D/g, '')); setTestNumberOpen(false); };
                        const Row = ({ name, number }) => (
                          <div
                            onMouseDown={(e) => { e.preventDefault(); pick(number); }}
                            style={{ padding: '8px 12px', cursor: 'pointer', fontFamily: FONT, borderBottom: `1px solid ${C.border}` }}
                            onMouseEnter={e => e.currentTarget.style.background = '#f9fafb'}
                            onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                          >
                            <div style={{ fontWeight: 600, color: C.text, fontSize: 13 }}>{name}</div>
                            <div style={{ fontSize: 11, color: C.textMuted }}>{maskPhone(number)}</div>
                          </div>
                        );
                        return (
                          <div style={{ position: 'absolute', top: '100%', left: 0, right: 0, marginTop: 4, background: 'var(--c-cardBg)', border: `1px solid ${C.border}`, borderRadius: 8, boxShadow: C.shadowMd, zIndex: 50, maxHeight: 320, overflowY: 'auto' }}>
                            {contactSugs.length > 0 && (
                              <div style={{ padding: '7px 12px 3px', fontSize: 10, fontWeight: 700, color: C.textMuted, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Contacts</div>
                            )}
                            {contactSugs.map(c => <Row key={'c' + c.contact_number} name={c.name || maskPhone(c.contact_number)} number={c.contact_number} />)}
                            {memberSugs.length > 0 && (
                              <div style={{ padding: '7px 12px 3px', fontSize: 10, fontWeight: 700, color: C.textMuted, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Team members</div>
                            )}
                            {memberSugs.map(tm => <Row key={'m' + tm.id} name={tm.name} number={tm.phone_number} />)}
                            {hiddenCount > 0 && (
                              <div style={{ padding: '8px 12px', fontSize: 11, color: C.textMuted, fontFamily: FONT, textAlign: 'center' }}>
                                +{hiddenCount} more — keep typing to narrow
                              </div>
                            )}
                            {contactSugs.length === 0 && memberSugs.length === 0 && (
                              <div style={{ padding: '10px 12px', fontSize: 12, color: C.textMuted, fontFamily: FONT }}>
                                {qDigits.length >= 7 ? 'No match — press Send Test to use this number' : 'Type a full number, or search a contact / team member'}
                              </div>
                            )}
                          </div>
                        );
                      })()}
                    </div>
                    <button
                      onClick={async () => {
                        const testNo = String(testNumber || '').replace(/\D/g, '');
                        // Test number is independent of recipients — allow with "TO" empty.
                        if (!testNo || !broadcastFrom) return;
                        if (testNo.length < 7) { notify('Enter a valid test phone number (digits only, at least 7 digits).'); return; }
                        if (broadcastMessageType === 'template' && !selectedTemplate) return;
                        if (broadcastMessageType === 'text' && !broadcastBody.trim()) return;
                        if (broadcastMessageType === 'link' && !broadcastUrl.trim()) return;
                        if (['image', 'video', 'audio', 'document'].includes(broadcastMessageType) && !broadcastMediaLibraryId) return;
                        if (headerMediaType && !broadcastMediaLibraryId) return;
                        setSendingTest(true);
                        try {
                          const payload = {
                            from_number: broadcastFrom,
                            recipient_numbers: selectedRecipients.map(r => ({ contact_number: r.contact_number, name: r.name })),
                            status: 'DRAFT',
                            test_number: testNo,
                            name: broadcastName.trim() || undefined,
                            message_type: broadcastMessageType,
                          };
                          if (broadcastMessageType === 'template') {
                            payload.template_id = selectedTemplate.id;
                            payload.variable_mapping = broadcastVariableMapping;
                          } else if (broadcastMessageType === 'text') {
                            payload.body = broadcastBody;
                          } else if (broadcastMessageType === 'link') {
                            payload.url = broadcastUrl;
                          } else if (['image', 'video', 'audio', 'document'].includes(broadcastMessageType)) {
                            payload.media_library_id = Number(broadcastMediaLibraryId);
                            payload.caption = broadcastCaption || undefined;
                          }
                          const broadcast = await api.broadcasts.create(payload);
                          await api.broadcasts.test(broadcast.id, testNo);
                          notify(`Test sent to ${testNo}. Check that WhatsApp to confirm delivery.`);
                        } catch (err) {
                          notify('Test failed: ' + err.message);
                        } finally {
                          setSendingTest(false);
                        }
                      }}
                      disabled={!testNumber.trim() || !broadcastFrom || sendingTest || (broadcastMessageType === 'template' && !selectedTemplate) || (broadcastMessageType === 'text' && !broadcastBody.trim()) || (broadcastMessageType === 'link' && !broadcastUrl.trim()) || (['image','video','audio','document'].includes(broadcastMessageType) && !broadcastMediaLibraryId) || (headerMediaType && !broadcastMediaLibraryId)}
                      style={{
                        padding: '10px 16px', borderRadius: 8, border: 'none',
                        background: C.primary, color: '#fff',
                        cursor: (!testNumber.trim() || !selectedTemplate || !broadcastFrom || sendingTest) ? 'not-allowed' : 'pointer',
                        fontSize: 12, fontWeight: 700, fontFamily: FONT,
                        opacity: (!testNumber.trim() || !selectedTemplate || !broadcastFrom || sendingTest) ? 0.5 : 1,
                        display: 'flex', alignItems: 'center', gap: 4, whiteSpace: 'nowrap',
                      }}
                    >
                      {sendingTest ? <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} /> : <Send size={14} />}
                      Send Test
                    </button>
                  </div>
                </div>

                {/* Spacer */}
                <div style={{ flex: 1 }} />

                {/* Bottom Buttons */}
                <div style={{ display: 'flex', gap: 10, alignItems: 'center', justifyContent: 'space-between', paddingTop: 8, borderTop: `1px solid ${C.border}` }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, fontFamily: FONT, color: selectedRecipients.length > 0 ? C.text : C.textMuted, fontWeight: 600 }}>
                    <Users size={15} color={selectedRecipients.length > 0 ? C.primary : C.textMuted} />
                    {selectedRecipients.length > 0
                      ? <span><strong>{selectedRecipients.length}</strong> recipient{selectedRecipients.length === 1 ? '' : 's'} selected</span>
                      : <span>No recipients selected</span>}
                  </div>
                  <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                  <button onClick={() => { setBroadcastModal(false); setBroadcastMessage(''); setBroadcastTemplateId(''); setBroadcastName(''); setTestNumber(''); setBroadcastVariableMapping({}); setBroadcastMessageType('template'); setBroadcastBody(''); setBroadcastUrl(''); setBroadcastMediaLibraryId(''); setBroadcastMediaItems([]); setBroadcastCaption(''); setBroadcastMediaLoading(false); }} style={{
                    padding: '10px 18px', borderRadius: 8, border: `1px solid ${C.border}`,
                    background: 'transparent', cursor: 'pointer', fontSize: 13,
                    fontWeight: 600, color: C.textSecondary, fontFamily: FONT,
                  }}>Cancel</button>
                  <button
                    onClick={async () => {
                      if (isBroadcastFormInvalid()) return;
                      setBroadcasting(true);
                      try {
                        const payload = {
                          from_number: broadcastFrom,
                          recipient_numbers: selectedRecipients.map(r => ({ contact_number: r.contact_number, name: r.name })),
                          status: 'DRAFT',
                          test_number: testNumber || undefined,
                          name: broadcastName.trim() || undefined,
                          message_type: broadcastMessageType,
                        };
                        if (broadcastMessageType === 'template') {
                          payload.template_id = selectedTemplate.id;
                          payload.variable_mapping = broadcastVariableMapping;
                          if (headerMediaType && broadcastMediaLibraryId) payload.media_library_id = Number(broadcastMediaLibraryId);
                        } else if (broadcastMessageType === 'text') {
                          payload.body = broadcastBody;
                        } else if (broadcastMessageType === 'link') {
                          payload.url = broadcastUrl;
                        } else if (['image', 'video', 'audio', 'document'].includes(broadcastMessageType)) {
                          payload.media_library_id = Number(broadcastMediaLibraryId);
                          payload.caption = broadcastCaption || undefined;
                        }
                        await api.broadcasts.create(payload);
                        notify('Broadcast saved as draft');
                        setBroadcastModal(false);
                        setBroadcastTemplateId('');
                        setBroadcastName('');
                        setTestNumber('');
                        setBroadcastFrom('');
                        setBroadcastMessageType('template');
                        setBroadcastBody('');
                        setBroadcastUrl('');
                        setBroadcastMediaLibraryId('');
                        setBroadcastMediaItems([]);
                        setBroadcastCaption('');
                      } catch (err) {
                        notify('Save failed: ' + err.message);
                      } finally {
                        setBroadcasting(false);
                      }
                    }}
                    disabled={isBroadcastFormInvalid()}
                    style={{
                      padding: '10px 18px', borderRadius: 8, border: `1.5px solid ${C.primary}`,
                      background: 'var(--c-cardBg)', color: C.primary, cursor: isBroadcastFormInvalid() ? 'not-allowed' : 'pointer',
                      fontSize: 13, fontWeight: 700, fontFamily: FONT,
                      opacity: isBroadcastFormInvalid() ? 0.5 : 1,
                    }}
                  >
                    Save as Draft
                  </button>
                  <button
                    onClick={() => { if (!isBroadcastFormInvalid()) setShowBroadcastConfirm(true); }}
                    disabled={isBroadcastFormInvalid()}
                    style={{
                      padding: '10px 18px', borderRadius: 8, border: 'none',
                      background: isBroadcastFormInvalid() ? '#ccc' : C.primary,
                      color: '#fff', cursor: isBroadcastFormInvalid() ? 'not-allowed' : 'pointer',
                      fontSize: 13, fontWeight: 700, fontFamily: FONT,
                      display: 'flex', alignItems: 'center', gap: 6,
                    }}
                  >
                    {broadcasting && <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} />}
                    Broadcast{selectedRecipients.length > 0 ? ` (${selectedRecipients.length})` : ''}
                  </button>
                  </div>
                </div>
              </div>

              {/* RIGHT — Preview */}
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, paddingTop: 8 }}>
                <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.1em', color: '#888', fontFamily: FONT }}>Live Preview</div>
                {broadcastMessageType === 'template' ? (
                  <WhatsAppPreview template={previewTemplate} minHeight={280} emptyText="Select a template&#10;to preview" />
                ) : (
                  <BroadcastMessagePreview
                    messageType={broadcastMessageType}
                    body={broadcastBody}
                    url={broadcastUrl}
                    mediaLibraryId={broadcastMediaLibraryId}
                    caption={broadcastCaption}
                    mediaItems={broadcastMediaItems}
                    minHeight={280}
                  />
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Broadcast confirmation */}
      {showBroadcastConfirm && (
        <div onClick={() => setShowBroadcastConfirm(false)} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 300, fontFamily: FONT }}>
          <div onClick={e => e.stopPropagation()} style={{ background: C.cardBg, borderRadius: 14, width: 420, boxShadow: C.shadowLg, padding: 24 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
              <div style={{ width: 38, height: 38, borderRadius: '50%', background: '#FCEBEB', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                <Send size={18} color={C.primary} />
              </div>
              <div style={{ fontSize: 17, fontWeight: 700, color: C.text }}>Send this broadcast?</div>
            </div>
            <div style={{ fontSize: 13.5, color: C.textSecondary, lineHeight: 1.6, marginBottom: 18 }}>
              You're about to send this message to <strong style={{ color: C.text }}>{selectedRecipients.length}</strong> recipient{selectedRecipients.length === 1 ? '' : 's'} from <strong style={{ color: C.text }}>{maskPhone(broadcastFrom)}</strong>.
              {broadcastMessageType === 'template' && selectedTemplate ? <> Template: <strong style={{ color: C.text }}>{selectedTemplate.name}</strong>.</> : null}
              <br />This action cannot be undone.
            </div>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button onClick={() => setShowBroadcastConfirm(false)} style={{ padding: '10px 18px', borderRadius: 8, border: `1px solid ${C.border}`, background: 'transparent', cursor: 'pointer', fontSize: 13, fontWeight: 600, color: C.textSecondary, fontFamily: FONT }}>Cancel</button>
              <button
                onClick={() => { setShowBroadcastConfirm(false); runBroadcast(); }}
                disabled={broadcasting}
                style={{ padding: '10px 18px', borderRadius: 8, border: 'none', background: C.primary, color: '#fff', cursor: broadcasting ? 'not-allowed' : 'pointer', fontSize: 13, fontWeight: 700, fontFamily: FONT, display: 'flex', alignItems: 'center', gap: 6 }}
              >
                <Send size={14} /> Yes, Broadcast Now
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Contact Detail / Edit Modal */}
      {detailContact && (
        <div style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,.35)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          zIndex: 200, fontFamily: FONT,
        }}>
          <div style={{
            background: C.cardBg, borderRadius: 14,
            padding: '24px 24px 20px', width: 480, maxHeight: '85vh',
            boxShadow: C.shadowLg, overflowY: 'auto',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
              <div style={{ fontSize: 16, fontWeight: 700, color: C.text }}>
                {detailMode === 'edit' ? 'Edit Contact' : 'Contact Details'}
              </div>
              <button onClick={() => setDetailContact(null)} style={{
                border: 'none', background: 'transparent', cursor: 'pointer', color: C.textMuted,
              }}><X size={18} /></button>
            </div>

            <div style={{ marginBottom: 16 }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: C.textSecondary, marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.04em' }}>Name</div>
              {detailMode === 'edit' ? (
                <input
                  value={detailName}
                  onChange={e => setDetailName(e.target.value)}
                  placeholder="Contact name"
                  style={{
                    width: '100%', padding: '8px 12px', borderRadius: 8,
                    border: `1px solid ${C.border}`, fontSize: 14, fontFamily: FONT,
                    color: C.text, outline: 'none', background: 'var(--c-cardBg)', boxSizing: 'border-box',
                  }}
                />
              ) : (
                <div style={{ fontSize: 15, fontWeight: 600, color: C.text }}>{detailContact.name || '—'}</div>
              )}
            </div>

            <div style={{ marginBottom: 16 }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: C.textSecondary, marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.04em' }}>Phone</div>
              {detailMode === 'edit' ? (
                <>
                  <input
                    value={detailNumber}
                    onChange={e => setDetailNumber(e.target.value)}
                    placeholder="e.g. 919876543210"
                    inputMode="numeric"
                    style={{
                      width: '100%', padding: '8px 12px', borderRadius: 8,
                      border: `1px solid ${C.border}`, fontSize: 14, fontFamily: 'DM Mono, monospace',
                      color: C.text, outline: 'none', background: 'var(--c-cardBg)', boxSizing: 'border-box',
                    }}
                  />
                  {String(detailNumber || '').replace(/\D/g, '') !== String(detailContact.contact_number) && (
                    <div style={{ fontSize: 11, color: '#E65100', marginTop: 4, display: 'flex', alignItems: 'center', gap: 4 }}>
                      <AlertTriangle size={11} /> Changing the number moves the entire conversation &amp; history to it.
                    </div>
                  )}
                </>
              ) : (
                <div style={{ fontSize: 14, color: C.textSecondary, display: 'flex', alignItems: 'center', gap: 4 }}>
                  <Phone size={12} /> <MaskedNumber number={detailContact.contact_number} prefix="+" />
                </div>
              )}
            </div>

            {/* Assigned to (admin-only — picker hidden for BDA Sales users) */}
            {(isAdmin || detailAssignedUserName) && (
              <div style={{ marginBottom: 16 }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: C.textSecondary, marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.04em' }}>Assigned to</div>
                {detailMode === 'edit' && isAdmin ? (
                  <SearchableSelect
                    value={detailAssignedUserId == null ? '' : String(detailAssignedUserId)}
                    onChange={(val) => setDetailAssignedUserId(val === '' ? null : Number(val))}
                    options={[
                      { value: '', label: '— Unassigned —' },
                      ...usersForAssign.map(u => ({
                        value: String(u.id),
                        label: `${u.displayName} · ${u.role === 'admin' ? 'Admin' : 'BDA Sales'}`,
                        sublabel: u.email || '',
                      })),
                    ]}
                    placeholder="— Unassigned —"
                    searchPlaceholder="Search team..."
                    triggerStyle={{ padding: '8px 12px', border: `1px solid ${C.border}` }}
                  />
                ) : (
                  <div style={{ fontSize: 14, color: C.text, display: 'flex', alignItems: 'center', gap: 6 }}>
                    {detailAssignedUserName ? (
                      <span style={{
                        display: 'inline-flex', alignItems: 'center',
                        padding: '3px 10px', borderRadius: 999,
                        background: '#E5F2EE', color: '#0F6E56',
                        border: '1px solid #B8DCCF',
                        fontSize: 12, fontWeight: 700,
                      }}>
                        {detailAssignedUserName}
                      </span>
                    ) : (
                      <span style={{ color: C.textMuted, fontStyle: 'italic', fontSize: 13 }}>Unassigned</span>
                    )}
                  </div>
                )}
                {detailMode === 'edit' && isAdmin && (
                  <div style={{ fontSize: 11, color: C.textMuted, marginTop: 4 }}>
                    Only the assigned user (and admins) can see this conversation.
                  </div>
                )}
              </div>
            )}

            <div style={{ marginBottom: detailMode === 'edit' ? 8 : 20 }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: C.textSecondary, marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.04em' }}>Assigned Tags</div>
              {detailTags.length === 0 ? (
                <div style={{ color: C.textMuted, fontSize: 12 }}>No tags assigned</div>
              ) : (
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
                  {detailTags.map(t => {
                    const info = getTagInfo(t);
                    return <TagBadge key={t.id} tag={info} onRemove={detailMode === 'edit' ? () => toggleTag(info) : null} />;
                  })}
                </div>
              )}
            </div>

            {/* Custom Fields */}
            {contactFields.length > 0 && (
              <div style={{ marginBottom: 20 }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: C.textSecondary, marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.04em' }}>Custom Fields</div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                  {contactFields.map(field => {
                    const value = detailCustomFields[field.id] || '';
                    const error = fieldErrors[field.id];
                    if (detailMode === 'view') {
                      return (
                        <div key={field.id}>
                          <div style={{ fontSize: 11, fontWeight: 600, color: C.textSecondary, marginBottom: 3 }}>{field.name}</div>
                          <div style={{ fontSize: 14, color: value ? C.text : C.textMuted }}>
                            {value || '—'}
                          </div>
                        </div>
                      );
                    }
                    const isTextarea = field.field_type === 'textarea';
                    const inputType = field.field_type === 'date' ? 'date' : field.field_type === 'number' ? 'text' : field.field_type === 'email' ? 'email' : field.field_type === 'url' ? 'url' : 'text';
                    return (
                      <div key={field.id}>
                        <div style={{ fontSize: 11, fontWeight: 600, color: C.textSecondary, marginBottom: 4 }}>{field.name}</div>
                        {isTextarea ? (
                          <textarea
                            value={value}
                            onChange={e => handleCustomFieldChange(field.id, e.target.value)}
                            onBlur={() => { const err = validateField(field, value); setFieldErrors(prev => ({ ...prev, [field.id]: err })); }}
                            placeholder={`Enter ${field.name.toLowerCase()}...`}
                            rows={2}
                            style={{
                              width: '100%', padding: '8px 10px', borderRadius: 6,
                              border: `1px solid ${error ? '#dc2626' : C.border}`, fontSize: 13,
                              fontFamily: FONT, color: C.text, outline: 'none',
                              boxSizing: 'border-box', resize: 'vertical',
                            }}
                          />
                        ) : (
                          <input
                            type={inputType}
                            value={value}
                            onChange={e => handleCustomFieldChange(field.id, e.target.value)}
                            onBlur={() => { const err = validateField(field, value); setFieldErrors(prev => ({ ...prev, [field.id]: err })); }}
                            placeholder={`Enter ${field.name.toLowerCase()}...`}
                            inputMode={field.field_type === 'number' ? 'decimal' : field.field_type === 'phone' ? 'tel' : undefined}
                            style={{
                              width: '100%', padding: '8px 10px', borderRadius: 6,
                              border: `1px solid ${error ? '#dc2626' : C.border}`, fontSize: 13,
                              fontFamily: FONT, color: C.text, outline: 'none',
                              boxSizing: 'border-box',
                            }}
                          />
                        )}
                        {error && (
                          <div style={{ fontSize: 11, color: '#dc2626', marginTop: 2 }}>{error}</div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Tag picker — only in edit mode */}
            {detailMode === 'edit' && (
              <div style={{ marginBottom: 20 }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: C.textSecondary, marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.04em' }}>Assign Tags</div>
                {detailLoading ? (
                  <div style={{ color: C.textMuted, fontSize: 12 }}>Loading tags…</div>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                    {categories.map(cat => {
                      const catTags = tags.filter(t => t.category_id === cat.id);
                      if (catTags.length === 0) return null;
                      const selectedInCat = detailTags.find(t => t.category_id === cat.id);
                      return (
                        <div key={cat.id}>
                          <div style={{ fontSize: 12, fontWeight: 700, color: C.text, marginBottom: 6 }}>{cat.name}</div>
                          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                            {catTags.map(tag => {
                              const isSelected = detailTags.some(t => t.id === tag.id);
                              return (
                                <button
                                  key={tag.id}
                                  onClick={() => toggleTag(tag)}
                                  style={{
                                    padding: '4px 10px', borderRadius: 4,
                                    border: `1.5px solid ${isSelected ? tag.color : C.border}`,
                                    background: isSelected ? tag.color : 'var(--c-cardBg)',
                                    color: isSelected ? '#fff' : C.textSecondary,
                                    cursor: 'pointer', fontFamily: FONT, fontSize: 12,
                                    fontWeight: 600,
                                  }}
                                >
                                  {tag.name}
                                </button>
                              );
                            })}
                          </div>
                          {selectedInCat && (
                            <div style={{ fontSize: 11, color: C.textMuted, marginTop: 4 }}>
                              Selected: <strong style={{ color: selectedInCat.color }}>{selectedInCat.name}</strong>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}

            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              {detailMode === 'view' ? (
                <>
                  <button onClick={() => setDetailContact(null)} style={{
                    padding: '8px 16px', borderRadius: 8, border: `1px solid ${C.border}`,
                    background: 'transparent', cursor: 'pointer', fontSize: 13,
                    fontWeight: 600, color: C.textSecondary, fontFamily: FONT,
                  }}>Close</button>
                  <button onClick={() => setDetailMode('edit')} style={{
                    padding: '8px 16px', borderRadius: 8, border: 'none',
                    background: C.primary, color: '#fff', cursor: 'pointer',
                    fontSize: 13, fontWeight: 600, fontFamily: FONT,
                  }}>
                    <Pencil size={14} style={{ verticalAlign: 'middle', marginRight: 4 }} />Edit
                  </button>
                </>
              ) : (
                <>
                  <button onClick={() => setDetailContact(null)} style={{
                    padding: '8px 16px', borderRadius: 8, border: `1px solid ${C.border}`,
                    background: 'transparent', cursor: 'pointer', fontSize: 13,
                    fontWeight: 600, color: C.textSecondary, fontFamily: FONT,
                  }}>Cancel</button>
                  <button onClick={saveDetail} disabled={savingDetail} style={{
                    padding: '8px 16px', borderRadius: 8, border: 'none',
                    background: C.primary, color: '#fff', cursor: savingDetail ? 'not-allowed' : 'pointer',
                    fontSize: 13, fontWeight: 600, fontFamily: FONT,
                    opacity: savingDetail ? 0.6 : 1, display: 'flex', alignItems: 'center', gap: 6,
                  }}>
                    {savingDetail && <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} />}
                    Save
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
