/* ═══════════════════════════════════════════════════════════════════════════
   ABL Underwriting Tool — app.js
   ═══════════════════════════════════════════════════════════════════════════ */

// ── PDF.js worker ────────────────────────────────────────────────────────────
if (typeof pdfjsLib !== 'undefined') {
  pdfjsLib.GlobalWorkerOptions.workerSrc =
    'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
}

// ── Storage ──────────────────────────────────────────────────────────────────
const STORAGE_KEY = 'abl_uw_deals_v2';
const SETTINGS_KEY = 'abl_uw_settings';

function loadDeals() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]'); } catch { return []; }
}
function saveDeals(deals) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(deals));
}
function loadSettings() {
  try { return JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}'); } catch { return {}; }
}
function saveSettings(s) {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
}

// ── State ─────────────────────────────────────────────────────────────────────
let deals = loadDeals();
let settings = loadSettings();
let activeDealId = null;
let extractedData = {};
let loadedFiles = [];

// Dynamic table rows (owners, debt, AR aging, inventory, RE, equipment, etc.)
const dynamicTables = {
  owners: [],
  debts: [],
  arAging: [],
  inventory: [],
  realEstate: [],
  equipment: [],
  findings: [],
  monitoring: [],
  bbcTrend: [],
  covenants: []
};

// ── Helpers ───────────────────────────────────────────────────────────────────
function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2); }
function fmtCurrency(n) {
  if (n == null || isNaN(n) || n === '') return '—';
  return '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}
function fmtPct(n) { return (n == null || n === '') ? '—' : Number(n).toFixed(1) + '%'; }
function apiKey() {
  return (settings.apiKey && settings.apiKey !== '') ? settings.apiKey :
         (typeof CONFIG !== 'undefined' && CONFIG.ANTHROPIC_API_KEY !== 'YOUR_API_KEY_HERE') ? CONFIG.ANTHROPIC_API_KEY : null;
}

// ── Init ──────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  applySettings();
  renderDealList();
  bindGlobalEvents();
  initFinancialTables();
  initRatioTable();
  initDefaultMonitoringItems();

  if (deals.length > 0) openDeal(deals[0].id);
});

function applySettings() {
  const s = settings;
  if (s.company) {
    document.getElementById('company-subtitle').textContent = s.company;
    document.getElementById('settings-company').value = s.company;
  }
  if (s.apiKey) document.getElementById('settings-api-key').value = s.apiKey;
  if (s.arRate) document.getElementById('settings-ar-rate').value = s.arRate;
  if (s.invRate) document.getElementById('settings-inv-rate').value = s.invRate;
}

// ── Deal List Sidebar ─────────────────────────────────────────────────────────
function renderDealList() {
  const list = document.getElementById('deal-list');
  list.innerHTML = '';
  if (deals.length === 0) {
    list.innerHTML = '<div style="color:rgba(255,255,255,.4);font-size:12px;padding:8px 10px;">No deals yet</div>';
    return;
  }
  deals.forEach(d => {
    const el = document.createElement('div');
    el.className = 'deal-item' + (d.id === activeDealId ? ' active' : '');
    el.dataset.id = d.id;
    el.innerHTML = `<div class="deal-name">${escHtml(d.data.deal_borrower_name || 'Untitled Deal')}</div>
      <div class="deal-meta">${escHtml(d.data.deal_stage || 'Prospect')} · ${d.updatedAt ? new Date(d.updatedAt).toLocaleDateString() : '—'}</div>`;
    el.addEventListener('click', () => openDeal(d.id));
    list.appendChild(el);
  });
}

// ── Open / Create Deal ────────────────────────────────────────────────────────
function openDeal(id) {
  activeDealId = id;
  const deal = deals.find(d => d.id === id);
  if (!deal) return;

  document.getElementById('empty-state').style.display = 'none';
  const ws = document.getElementById('deal-workspace');
  ws.style.display = 'flex';

  loadDealIntoForm(deal.data);
  loadDynamicTables(deal);
  updateDealHeaderBar(deal);
  renderDealList();
  recalcAll();
}

function loadDealIntoForm(data) {
  document.querySelectorAll('[data-field]').forEach(el => {
    const key = el.dataset.field;
    if (data[key] != null) el.value = data[key];
    else el.value = '';
  });
}

function loadDynamicTables(deal) {
  const d = deal.dynamic || {};
  dynamicTables.owners = d.owners || [];
  dynamicTables.debts = d.debts || [];
  dynamicTables.arAging = d.arAging || [];
  dynamicTables.inventory = d.inventory || [];
  dynamicTables.realEstate = d.realEstate || [];
  dynamicTables.equipment = d.equipment || [];
  dynamicTables.findings = d.findings || [];
  dynamicTables.monitoring = d.monitoring || getDefaultMonitoringItems();
  dynamicTables.bbcTrend = d.bbcTrend || [];
  dynamicTables.covenants = d.covenants || getDefaultCovenants();

  renderOwnersTable();
  renderDebtTable();
  renderArAgingTable();
  renderInventoryTable();
  renderRETable();
  renderEquipmentTable();
  renderFindingsTable();
  renderMonitoringTable();
  renderBBCTrendTable();
  renderCovenantTable();
  renderVersionList(deal);
  renderActivityLog(deal);
}

function updateDealHeaderBar(deal) {
  const name = deal.data.deal_borrower_name || 'Untitled Deal';
  const stage = deal.data.deal_stage || 'Prospect';
  document.getElementById('deal-title-display').textContent = name;
  const badge = document.getElementById('deal-stage-badge');
  badge.textContent = stage;
  badge.className = 'badge ' + stageBadgeClass(stage);
}

function stageBadgeClass(stage) {
  const map = {
    'Prospect': 'badge-gray', 'Term Sheet Issued': 'badge-blue',
    'Due Diligence': 'badge-yellow', 'Credit Approved': 'badge-green',
    'Closed': 'badge-green', 'Declined': 'badge-red'
  };
  return map[stage] || 'badge-gray';
}

function collectDealData() {
  const data = {};
  document.querySelectorAll('[data-field]').forEach(el => { data[el.dataset.field] = el.value; });
  return data;
}

function saveDeal() {
  if (!activeDealId) return;
  const idx = deals.findIndex(d => d.id === activeDealId);
  if (idx === -1) return;
  deals[idx].data = collectDealData();
  deals[idx].dynamic = { ...dynamicTables };
  deals[idx].updatedAt = new Date().toISOString();
  saveDeals(deals);
  renderDealList();
  updateDealHeaderBar(deals[idx]);
  addActivityEntry('Saved');
}

// ── Tabs ──────────────────────────────────────────────────────────────────────
function bindTabEvents() {
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));
      btn.classList.add('active');
      const pane = document.getElementById('tab-' + btn.dataset.tab);
      if (pane) pane.classList.add('active');
    });
  });
}

// ── Global Events ─────────────────────────────────────────────────────────────
function bindGlobalEvents() {
  bindTabEvents();

  // New deal
  ['btn-new-deal','btn-new-deal-2'].forEach(id => {
    document.getElementById(id)?.addEventListener('click', () => openModal('new-deal-modal'));
  });
  document.getElementById('btn-create-deal').addEventListener('click', createNewDeal);
  document.getElementById('btn-close-new-deal').addEventListener('click', () => closeModal('new-deal-modal'));
  document.getElementById('btn-cancel-new-deal').addEventListener('click', () => closeModal('new-deal-modal'));

  // Save / Export
  document.getElementById('btn-save').addEventListener('click', saveDeal);
  document.getElementById('btn-export').addEventListener('click', exportDeal);
  document.getElementById('btn-import-deal').addEventListener('click', importDeal);

  // Settings
  document.getElementById('btn-settings').addEventListener('click', () => openModal('settings-modal'));
  document.getElementById('btn-close-settings').addEventListener('click', () => closeModal('settings-modal'));
  document.getElementById('btn-cancel-settings').addEventListener('click', () => closeModal('settings-modal'));
  document.getElementById('btn-save-settings').addEventListener('click', saveSettingsFromModal);

  // Delete deal
  document.getElementById('btn-delete-deal').addEventListener('click', deleteDeal);

  // AI Panel
  document.getElementById('btn-ai-extract').addEventListener('click', openAIPanel);
  document.getElementById('btn-close-ai-panel').addEventListener('click', closeAIPanel);
  document.getElementById('btn-run-extraction').addEventListener('click', runExtraction);
  document.getElementById('btn-apply-extraction').addEventListener('click', applyExtraction);

  // Upload zone
  const zone = document.getElementById('upload-zone');
  const fileInput = document.getElementById('file-input');
  zone.addEventListener('click', () => fileInput.click());
  zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('drag-over'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'));
  zone.addEventListener('drop', e => { e.preventDefault(); zone.classList.remove('drag-over'); handleFiles(e.dataTransfer.files); });
  fileInput.addEventListener('change', e => handleFiles(e.target.files));

  // Dynamic table add-row buttons
  document.getElementById('btn-add-owner').addEventListener('click', () => { dynamicTables.owners.push(emptyOwner()); renderOwnersTable(); });
  document.getElementById('btn-add-debt').addEventListener('click', () => { dynamicTables.debts.push(emptyDebt()); renderDebtTable(); });
  document.getElementById('btn-add-aging-row').addEventListener('click', () => { dynamicTables.arAging.push(emptyAgingRow()); renderArAgingTable(); });
  document.getElementById('btn-add-inv-row').addEventListener('click', () => { dynamicTables.inventory.push(emptyInvRow()); renderInventoryTable(); });
  document.getElementById('btn-add-re-row').addEventListener('click', () => { dynamicTables.realEstate.push(emptyRERow()); renderRETable(); });
  document.getElementById('btn-add-equip-row').addEventListener('click', () => { dynamicTables.equipment.push(emptyEquipRow()); renderEquipmentTable(); });
  document.getElementById('btn-add-finding').addEventListener('click', () => { dynamicTables.findings.push(emptyFinding()); renderFindingsTable(); });
  document.getElementById('btn-add-monitor-row').addEventListener('click', () => { dynamicTables.monitoring.push(emptyMonitorRow()); renderMonitoringTable(); });
  document.getElementById('btn-add-trend-row').addEventListener('click', () => { dynamicTables.bbcTrend.push(emptyTrendRow()); renderBBCTrendTable(); });
  document.getElementById('btn-add-covenant').addEventListener('click', () => { dynamicTables.covenants.push(emptyCovenant()); renderCovenantTable(); });

  // Snapshot / history
  document.getElementById('btn-snapshot').addEventListener('click', saveSnapshot);

  // Auto-recalc on numeric field changes
  document.getElementById('tab-content').addEventListener('input', e => {
    if (e.target.dataset.field) recalcAll();
  });
  document.getElementById('tab-content').addEventListener('change', e => {
    if (e.target.dataset.field === 'deal_stage') {
      const deal = deals.find(d => d.id === activeDealId);
      if (deal) { deal.data.deal_stage = e.target.value; updateDealHeaderBar(deal); renderDealList(); }
    }
    if (e.target.dataset.field === 'deal_borrower_name') {
      const deal = deals.find(d => d.id === activeDealId);
      if (deal) { deal.data.deal_borrower_name = e.target.value; updateDealHeaderBar(deal); renderDealList(); }
    }
    if (e.target.dataset.field?.startsWith('fin_yr')) updateFinancialHeaders();
  });
}

// ── Modals ────────────────────────────────────────────────────────────────────
function openModal(id) { document.getElementById(id).classList.add('open'); }
function closeModal(id) { document.getElementById(id).classList.remove('open'); }

// ── Create New Deal ───────────────────────────────────────────────────────────
function createNewDeal() {
  const name = document.getElementById('nd-name').value.trim() || 'Untitled Deal';
  const stage = document.getElementById('nd-stage').value;
  const rm = document.getElementById('nd-rm').value;
  const uw = document.getElementById('nd-uw').value;
  const deal = {
    id: uid(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    data: {
      deal_borrower_name: name, deal_stage: stage, deal_rm: rm, deal_uw: uw,
      ar_advance_rate: settings.arRate || 85,
      inv_advance_rate: settings.invRate || 50
    },
    dynamic: {},
    versions: [],
    activityLog: [{ ts: new Date().toISOString(), msg: 'Deal created' }]
  };
  deals.unshift(deal);
  saveDeals(deals);
  closeModal('new-deal-modal');
  document.getElementById('nd-name').value = '';
  openDeal(deal.id);
}

// ── Delete Deal ───────────────────────────────────────────────────────────────
function deleteDeal() {
  if (!activeDealId) return;
  const deal = deals.find(d => d.id === activeDealId);
  if (!confirm(`Delete "${deal?.data?.deal_borrower_name || 'this deal'}"? This cannot be undone.`)) return;
  deals = deals.filter(d => d.id !== activeDealId);
  activeDealId = null;
  saveDeals(deals);
  renderDealList();
  document.getElementById('deal-workspace').style.display = 'none';
  document.getElementById('empty-state').style.display = '';
}

// ── Export / Import ───────────────────────────────────────────────────────────
function exportDeal() {
  if (!activeDealId) { alert('No deal selected.'); return; }
  saveDeal();
  const deal = deals.find(d => d.id === activeDealId);
  const blob = new Blob([JSON.stringify(deal, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url;
  a.download = `${(deal.data.deal_borrower_name || 'deal').replace(/[^a-z0-9]/gi, '_')}_uw.json`;
  a.click(); URL.revokeObjectURL(url);
}

function importDeal() {
  const input = document.createElement('input'); input.type = 'file'; input.accept = '.json';
  input.onchange = e => {
    const file = e.target.files[0]; if (!file) return;
    const reader = new FileReader();
    reader.onload = ev => {
      try {
        const deal = JSON.parse(ev.target.result);
        deal.id = uid(); deal.updatedAt = new Date().toISOString();
        deals.unshift(deal); saveDeals(deals);
        openDeal(deal.id);
      } catch { alert('Invalid deal file.'); }
    };
    reader.readAsText(file);
  };
  input.click();
}

// ── Settings ──────────────────────────────────────────────────────────────────
function saveSettingsFromModal() {
  settings.apiKey = document.getElementById('settings-api-key').value.trim();
  settings.company = document.getElementById('settings-company').value.trim();
  settings.arRate = parseFloat(document.getElementById('settings-ar-rate').value) || 85;
  settings.invRate = parseFloat(document.getElementById('settings-inv-rate').value) || 50;
  saveSettings(settings);
  document.getElementById('company-subtitle').textContent = settings.company;
  closeModal('settings-modal');
}

// ══════════════════════════════════════════════════════════════════════════════
// DYNAMIC TABLES
// ══════════════════════════════════════════════════════════════════════════════

function escHtml(s) { return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

function makeInput(val, cls) {
  return `<input type="text" value="${escHtml(val)}" class="${cls||''}" style="border:none;background:transparent;width:100%;font-size:13px;font-family:var(--font);padding:0" />`;
}
function makeNumInput(val, cls) {
  return `<input type="number" value="${val ?? ''}" class="${cls||''}" style="border:none;background:transparent;width:100%;font-size:13px;font-family:var(--font);padding:0;text-align:right" />`;
}
function makeSelect(val, opts) {
  return `<select style="border:none;background:transparent;width:100%;font-size:13px;font-family:var(--font);padding:0">${opts.map(o=>`<option${o===val?' selected':''}>${o}</option>`).join('')}</select>`;
}
function deleteBtn() {
  return `<button class="btn btn-danger btn-sm btn-icon" onclick="this.closest('tr').remove()" title="Delete">✕</button>`;
}

// ── Owners ────────────────────────────────────────────────────────────────────
function emptyOwner() { return { name:'', title:'', pct:'', guarantor:'Yes', bk:'No' }; }
function renderOwnersTable() {
  const tbody = document.getElementById('owner-tbody'); tbody.innerHTML = '';
  dynamicTables.owners.forEach((o, i) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${makeInput(o.name,'owner-name-'+i)}</td>
      <td>${makeInput(o.title,'owner-title-'+i)}</td>
      <td class="num">${makeNumInput(o.pct,'owner-pct-'+i)}</td>
      <td>${makeSelect(o.guarantor,['Yes','No'])}</td>
      <td>${makeSelect(o.bk,['No','Yes'])}</td>
      <td>${deleteBtn()}</td>`;
    tbody.appendChild(tr);
  });
}

// ── Debt ──────────────────────────────────────────────────────────────────────
function emptyDebt() { return { lender:'', type:'Term Loan', balance:'', rate:'', maturity:'', secured:'' }; }
function renderDebtTable() {
  const tbody = document.getElementById('debt-tbody'); tbody.innerHTML = '';
  dynamicTables.debts.forEach((d, i) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${makeInput(d.lender)}</td>
      <td>${makeSelect(d.type, ['Term Loan','Revolving LOC','Equipment Loan','Mortgage','Subordinated Debt','Other'])}</td>
      <td class="num">${makeNumInput(d.balance)}</td>
      <td class="num">${makeNumInput(d.rate)}</td>
      <td>${makeInput(d.maturity)}</td>
      <td>${makeInput(d.secured)}</td>
      <td>${deleteBtn()}</td>`;
    tbody.appendChild(tr);
  });
}

// ── A/R Aging ─────────────────────────────────────────────────────────────────
function emptyAgingRow() { return { customer:'', cur:0, d30:0, d60:0, d90:0, d90p:0 }; }
function renderArAgingTable() {
  const tbody = document.getElementById('ar-aging-tbody'); tbody.innerHTML = '';
  let tc=0,t30=0,t60=0,t90=0,t90p=0;
  dynamicTables.arAging.forEach(row => {
    const total = (+row.cur||0)+(+row.d30||0)+(+row.d60||0)+(+row.d90||0)+(+row.d90p||0);
    tc+=(+row.cur||0); t30+=(+row.d30||0); t60+=(+row.d60||0); t90+=(+row.d90||0); t90p+=(+row.d90p||0);
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${makeInput(row.customer)}</td>
      <td class="num">${makeNumInput(row.cur)}</td>
      <td class="num">${makeNumInput(row.d30)}</td>
      <td class="num">${makeNumInput(row.d60)}</td>
      <td class="num">${makeNumInput(row.d90)}</td>
      <td class="num">${makeNumInput(row.d90p)}</td>
      <td class="num" style="font-variant-numeric:tabular-nums">${fmtCurrency(total)}</td>
      <td class="num">—</td>
      <td>${deleteBtn()}</td>`;
    tbody.appendChild(tr);
  });
  const grandTotal = tc+t30+t60+t90+t90p;
  document.getElementById('ar-tot-cur').textContent = fmtCurrency(tc);
  document.getElementById('ar-tot-30').textContent = fmtCurrency(t30);
  document.getElementById('ar-tot-60').textContent = fmtCurrency(t60);
  document.getElementById('ar-tot-90').textContent = fmtCurrency(t90);
  document.getElementById('ar-tot-90p').textContent = fmtCurrency(t90p);
  document.getElementById('ar-tot-all').textContent = fmtCurrency(grandTotal);

  // Update gross AR field if empty
  const grossField = document.querySelector('[data-field="ar_gross"]');
  if (grossField && (!grossField.value || grossField.value == 0)) {
    grossField.value = grandTotal || '';
  }
  recalcAR();
}

// ── Inventory ─────────────────────────────────────────────────────────────────
function emptyInvRow() { return { category:'', basis:'Cost', book:0, nflv:0, eligible:0, rate:50, avail:0 }; }
function renderInventoryTable() {
  const tbody = document.getElementById('inv-tbody'); tbody.innerHTML = '';
  let tBook=0, tNflv=0, tElig=0, tAvail=0;
  dynamicTables.inventory.forEach(row => {
    const avail = (+row.eligible||0) * (+row.rate||0) / 100;
    tBook+=(+row.book||0); tNflv+=(+row.nflv||0); tElig+=(+row.eligible||0); tAvail+=avail;
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${makeInput(row.category)}</td>
      <td>${makeSelect(row.basis,['Cost','NFLV','Appraised','FMV'])}</td>
      <td class="num">${makeNumInput(row.book)}</td>
      <td class="num">${makeNumInput(row.nflv)}</td>
      <td class="num">${makeNumInput(row.eligible)}</td>
      <td class="num">${makeNumInput(row.rate)}</td>
      <td class="num">${fmtCurrency(avail)}</td>
      <td>${deleteBtn()}</td>`;
    tbody.appendChild(tr);
  });
  document.getElementById('inv-tot-book').textContent = fmtCurrency(tBook);
  document.getElementById('inv-tot-nflv').textContent = fmtCurrency(tNflv);
  document.getElementById('inv-tot-elig').textContent = fmtCurrency(tElig);
  document.getElementById('inv-tot-avail').textContent = fmtCurrency(tAvail);
  document.getElementById('kpi-inv-total').textContent = fmtCurrency(tBook);
  document.getElementById('kpi-inv-eligible').textContent = fmtCurrency(tElig);
  document.getElementById('kpi-inv-avail').textContent = fmtCurrency(tAvail);
}

// ── Real Estate ───────────────────────────────────────────────────────────────
function emptyRERow() { return { address:'', type:'Industrial', owned:'Owned', appraised:0, mortgage:0, rate:65, avail:0 }; }
function renderRETable() {
  const tbody = document.getElementById('re-tbody'); tbody.innerHTML = '';
  dynamicTables.realEstate.forEach(row => {
    const equity = Math.max(0, (+row.appraised||0) - (+row.mortgage||0));
    const avail = equity * (+row.rate||0) / 100;
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${makeInput(row.address)}</td>
      <td>${makeSelect(row.type,['Industrial','Office','Warehouse','Retail','Mixed Use','Land','Other'])}</td>
      <td>${makeSelect(row.owned,['Owned','Leased'])}</td>
      <td class="num">${makeNumInput(row.appraised)}</td>
      <td class="num">${makeNumInput(row.mortgage)}</td>
      <td class="num">${makeNumInput(row.rate)}</td>
      <td class="num">${fmtCurrency(avail)}</td>
      <td>${deleteBtn()}</td>`;
    tbody.appendChild(tr);
  });
}

// ── Equipment ─────────────────────────────────────────────────────────────────
function emptyEquipRow() { return { desc:'', year:'', condition:'Good', fmv:0, nflv:0, lien:0, rate:50, avail:0 }; }
function renderEquipmentTable() {
  const tbody = document.getElementById('equip-tbody'); tbody.innerHTML = '';
  dynamicTables.equipment.forEach(row => {
    const net = Math.max(0, (+row.nflv||0) - (+row.lien||0));
    const avail = net * (+row.rate||0) / 100;
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${makeInput(row.desc)}</td>
      <td>${makeInput(row.year)}</td>
      <td>${makeSelect(row.condition,['Excellent','Good','Fair','Poor'])}</td>
      <td class="num">${makeNumInput(row.fmv)}</td>
      <td class="num">${makeNumInput(row.nflv)}</td>
      <td class="num">${makeNumInput(row.lien)}</td>
      <td class="num">${makeNumInput(row.rate)}</td>
      <td class="num">${fmtCurrency(avail)}</td>
      <td>${deleteBtn()}</td>`;
    tbody.appendChild(tr);
  });
}

// ── Field Exam Findings ───────────────────────────────────────────────────────
function emptyFinding() { return { area:'', finding:'', severity:'Medium', recommendation:'', status:'Open' }; }
function renderFindingsTable() {
  const tbody = document.getElementById('findings-tbody'); tbody.innerHTML = '';
  dynamicTables.findings.forEach((f, i) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${i+1}</td>
      <td>${makeSelect(f.area, ['A/R','Inventory','Cash','Management','Systems','Legal','General'])}</td>
      <td>${makeInput(f.finding)}</td>
      <td>${makeSelect(f.severity,['Critical','High','Medium','Low','Informational'])}</td>
      <td>${makeInput(f.recommendation)}</td>
      <td>${makeSelect(f.status,['Open','In Progress','Resolved','Waived'])}</td>
      <td>${deleteBtn()}</td>`;
    tbody.appendChild(tr);
  });
}

// ── Collateral Monitoring ─────────────────────────────────────────────────────
function emptyMonitorRow() { return { report:'', freq:'Monthly', due:'', lastRec:'', status:'Current', notes:'' }; }
function getDefaultMonitoringItems() {
  return [
    { report:'Borrowing Base Certificate', freq:'Monthly', due:'', lastRec:'', status:'Current', notes:'' },
    { report:'A/R Aging Report', freq:'Monthly', due:'', lastRec:'', status:'Current', notes:'' },
    { report:'Inventory Report', freq:'Monthly', due:'', lastRec:'', status:'Current', notes:'' },
    { report:'Financial Statements (Interim)', freq:'Monthly', due:'', lastRec:'', status:'Current', notes:'' },
    { report:'Annual Audited Financials', freq:'Annual', due:'', lastRec:'', status:'Current', notes:'' },
    { report:'Field Exam / Audit', freq:'Annual', due:'', lastRec:'', status:'Scheduled', notes:'' },
    { report:'Insurance Certificates', freq:'Annual', due:'', lastRec:'', status:'Current', notes:'' },
    { report:'Covenant Compliance Certificate', freq:'Quarterly', due:'', lastRec:'', status:'Current', notes:'' },
  ];
}
function renderMonitoringTable() {
  const tbody = document.getElementById('monitor-tbody'); tbody.innerHTML = '';
  dynamicTables.monitoring.forEach(row => {
    const statusColor = { Current:'badge-green', Overdue:'badge-red', Pending:'badge-yellow', Scheduled:'badge-blue' }[row.status] || 'badge-gray';
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${makeInput(row.report)}</td>
      <td>${makeSelect(row.freq,['Daily','Weekly','Monthly','Quarterly','Semi-Annual','Annual','As Needed'])}</td>
      <td>${makeInput(row.due)}</td>
      <td>${makeInput(row.lastRec)}</td>
      <td><span class="badge ${statusColor}">${escHtml(row.status)}</span></td>
      <td>${makeInput(row.notes)}</td>
      <td>${deleteBtn()}</td>`;
    tbody.appendChild(tr);
  });
}

// ── BBC Trend ─────────────────────────────────────────────────────────────────
function emptyTrendRow() { return { period:'', grossAR:0, netElig:0, inv:0, totalBB:0, outstanding:0, avail:0 }; }
function renderBBCTrendTable() {
  const tbody = document.getElementById('bbc-trend-tbody'); tbody.innerHTML = '';
  dynamicTables.bbcTrend.forEach(row => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${makeInput(row.period)}</td>
      <td class="num">${makeNumInput(row.grossAR)}</td>
      <td class="num">${makeNumInput(row.netElig)}</td>
      <td class="num">${makeNumInput(row.inv)}</td>
      <td class="num">${makeNumInput(row.totalBB)}</td>
      <td class="num">${makeNumInput(row.outstanding)}</td>
      <td class="num">${makeNumInput(row.avail)}</td>
      <td>${deleteBtn()}</td>`;
    tbody.appendChild(tr);
  });
}

// ── Covenants ─────────────────────────────────────────────────────────────────
function emptyCovenant() { return { name:'', type:'Financial', threshold:'', freq:'Quarterly', testDate:'', actual:'', status:'Pass', notes:'' }; }
function getDefaultCovenants() {
  return [
    { name:'Minimum Fixed Charge Coverage Ratio', type:'Financial', threshold:'≥ 1.10x', freq:'Quarterly', testDate:'', actual:'', status:'Pass', notes:'' },
    { name:'Maximum Leverage Ratio (Debt/EBITDA)', type:'Financial', threshold:'≤ 4.0x', freq:'Quarterly', testDate:'', actual:'', status:'Pass', notes:'' },
    { name:'Minimum Liquidity / Excess Availability', type:'Financial', threshold:'≥ $500K', freq:'Monthly', testDate:'', actual:'', status:'Pass', notes:'' },
    { name:'Maximum Capital Expenditures', type:'Financial', threshold:'Per Approved Budget', freq:'Annual', testDate:'', actual:'', status:'Pass', notes:'' },
    { name:'No Material Adverse Change', type:'Reporting', threshold:'N/A', freq:'Ongoing', testDate:'', actual:'', status:'Pass', notes:'' },
    { name:'Annual Audited Financial Statements', type:'Reporting', threshold:'Within 120 days of FYE', freq:'Annual', testDate:'', actual:'', status:'Pass', notes:'' },
    { name:'Monthly Borrowing Base Certificate', type:'Reporting', threshold:'Within 15 days of month-end', freq:'Monthly', testDate:'', actual:'', status:'Pass', notes:'' },
  ];
}
function renderCovenantTable() {
  const tbody = document.getElementById('covenant-tbody'); tbody.innerHTML = '';
  dynamicTables.covenants.forEach(row => {
    const dotClass = { Pass:'pass', Fail:'fail', Waiver:'waiver', 'N/A':'na' }[row.status] || 'na';
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${makeInput(row.name)}</td>
      <td>${makeSelect(row.type,['Financial','Reporting','Affirmative','Negative','Other'])}</td>
      <td>${makeInput(row.threshold)}</td>
      <td>${makeSelect(row.freq,['Monthly','Quarterly','Semi-Annual','Annual','Ongoing'])}</td>
      <td>${makeInput(row.testDate)}</td>
      <td class="num">${makeInput(row.actual)}</td>
      <td>
        <div class="covenant-status">
          <div class="status-dot ${dotClass}"></div>
          ${makeSelect(row.status,['Pass','Fail','Waiver','N/A'])}
        </div>
      </td>
      <td>${makeInput(row.notes)}</td>
      <td>${deleteBtn()}</td>`;
    tbody.appendChild(tr);
  });
}

// ── Financial Tables ──────────────────────────────────────────────────────────
const INCOME_ROWS = [
  ['Revenue / Net Sales', 'fin_revenue'],
  ['Cost of Goods Sold', 'fin_cogs'],
  ['Gross Profit', 'fin_gross_profit'],
  ['Operating Expenses (SG&A)', 'fin_sga'],
  ['EBITDA', 'fin_ebitda'],
  ['Depreciation & Amortization', 'fin_da'],
  ['EBIT', 'fin_ebit'],
  ['Interest Expense', 'fin_interest'],
  ['Other Income / (Expense)', 'fin_other_inc'],
  ['Pre-Tax Income', 'fin_pretax'],
  ['Taxes', 'fin_taxes'],
  ['Net Income', 'fin_net_income'],
];
const BS_ROWS = [
  ['Cash & Equivalents', 'bs_cash'],
  ['Accounts Receivable (Net)', 'bs_ar'],
  ['Inventory', 'bs_inv'],
  ['Other Current Assets', 'bs_oca'],
  ['Total Current Assets', 'bs_tca'],
  ['PP&E (Net)', 'bs_ppe'],
  ['Total Assets', 'bs_total_assets'],
  ['Accounts Payable', 'bs_ap'],
  ['Current Portion LTD', 'bs_cpltd'],
  ['Other Current Liabilities', 'bs_ocl'],
  ['Total Current Liabilities', 'bs_tcl'],
  ['Long-Term Debt', 'bs_ltd'],
  ['Total Liabilities', 'bs_total_liab'],
  ['Total Equity', 'bs_equity'],
];
const RATIO_ROWS = [
  ['Fixed Charge Coverage Ratio (FCCR)', 'ratio_fccr'],
  ['Total Leverage (Debt / EBITDA)', 'ratio_leverage'],
  ['Current Ratio', 'ratio_current'],
  ['Quick Ratio', 'ratio_quick'],
  ['Gross Margin (%)', 'ratio_gm'],
  ['EBITDA Margin (%)', 'ratio_ebitda_margin'],
  ['Net Profit Margin (%)', 'ratio_npm'],
  ['Days Sales Outstanding (DSO)', 'ratio_dso'],
  ['Days Inventory Outstanding (DIO)', 'ratio_dio'],
  ['Days Payable Outstanding (DPO)', 'ratio_dpo'],
];

function initFinancialTables() {
  const incomeTbody = document.getElementById('income-tbody');
  INCOME_ROWS.forEach(([label, key]) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td><strong>${label}</strong></td>
      <td class="num"><input type="number" data-field="${key}_yr1" style="width:100%;border:none;background:transparent;text-align:right;font-size:13px;font-family:var(--font)" /></td>
      <td class="num"><input type="number" data-field="${key}_yr2" style="width:100%;border:none;background:transparent;text-align:right;font-size:13px;font-family:var(--font)" /></td>
      <td class="num"><input type="number" data-field="${key}_yr3" style="width:100%;border:none;background:transparent;text-align:right;font-size:13px;font-family:var(--font)" /></td>
      <td class="num"><input type="number" data-field="${key}_ttm" style="width:100%;border:none;background:transparent;text-align:right;font-size:13px;font-family:var(--font)" /></td>
      <td class="num"><input type="number" data-field="${key}_proj" style="width:100%;border:none;background:transparent;text-align:right;font-size:13px;font-family:var(--font)" /></td>`;
    incomeTbody.appendChild(tr);
  });

  const bsTbody = document.getElementById('bs-tbody');
  BS_ROWS.forEach(([label, key]) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td><strong>${label}</strong></td>
      <td class="num"><input type="number" data-field="${key}_yr1" style="width:100%;border:none;background:transparent;text-align:right;font-size:13px;font-family:var(--font)" /></td>
      <td class="num"><input type="number" data-field="${key}_yr2" style="width:100%;border:none;background:transparent;text-align:right;font-size:13px;font-family:var(--font)" /></td>
      <td class="num"><input type="number" data-field="${key}_yr3" style="width:100%;border:none;background:transparent;text-align:right;font-size:13px;font-family:var(--font)" /></td>
      <td class="num"><input type="number" data-field="${key}_interim" style="width:100%;border:none;background:transparent;text-align:right;font-size:13px;font-family:var(--font)" /></td>`;
    bsTbody.appendChild(tr);
  });

  const ratioTbody = document.getElementById('ratio-tbody');
  RATIO_ROWS.forEach(([label, key]) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td><strong>${label}</strong></td>
      <td class="num"><input type="number" data-field="${key}_yr1" step="0.01" style="width:100%;border:none;background:transparent;text-align:right;font-size:13px;font-family:var(--font)" /></td>
      <td class="num"><input type="number" data-field="${key}_yr2" step="0.01" style="width:100%;border:none;background:transparent;text-align:right;font-size:13px;font-family:var(--font)" /></td>
      <td class="num"><input type="number" data-field="${key}_ttm" step="0.01" style="width:100%;border:none;background:transparent;text-align:right;font-size:13px;font-family:var(--font)" /></td>
      <td class="num"><input type="text" data-field="${key}_threshold" style="width:100%;border:none;background:transparent;text-align:right;font-size:13px;font-family:var(--font)" placeholder="—" /></td>
      <td><select data-field="${key}_status" style="border:none;background:transparent;font-size:12px;font-family:var(--font)"><option value="">—</option><option>Pass</option><option>Fail</option><option>Waiver</option><option>N/A</option></select></td>`;
    ratioTbody.appendChild(tr);
  });
}

function initRatioTable() {} // handled above

function initDefaultMonitoringItems() {
  // Only set if empty; done in loadDynamicTables
}

function updateFinancialHeaders() {
  const getVal = f => { const el = document.querySelector(`[data-field="${f}"]`); return el ? el.value : '—'; };
  ['fin-yr1-hdr','bs-yr1-hdr'].forEach(id => { const el = document.getElementById(id); if (el) el.textContent = 'FY ' + (getVal('fin_yr1_label') || '—'); });
  ['fin-yr2-hdr','bs-yr2-hdr'].forEach(id => { const el = document.getElementById(id); if (el) el.textContent = 'FY ' + (getVal('fin_yr2_label') || '—'); });
  ['fin-yr3-hdr','bs-yr3-hdr'].forEach(id => { const el = document.getElementById(id); if (el) el.textContent = 'FY ' + (getVal('fin_yr3_label') || '—'); });
}

// ── Calculations ──────────────────────────────────────────────────────────────
function getFieldVal(key) {
  const el = document.querySelector(`[data-field="${key}"]`);
  return el ? (parseFloat(el.value) || 0) : 0;
}
function setFieldVal(key, val) {
  const el = document.querySelector(`[data-field="${key}"]`);
  if (el) el.value = val != null ? val : '';
}

function recalcAll() {
  recalcAR();
  recalcBBC();
  updateFinancialHeaders();
}

function recalcAR() {
  const gross = getFieldVal('ar_gross');
  const ineligFields = ['inelig_over90','inelig_conc','inelig_crossage','inelig_contra','inelig_foreign','inelig_govt','inelig_disputed','inelig_unbilled','inelig_other'];
  const totalInelig = ineligFields.reduce((s, k) => s + getFieldVal(k), 0);
  const netElig = Math.max(0, gross - totalInelig);
  const rate = getFieldVal('ar_advance_rate') || 85;
  const avail = netElig * rate / 100;

  setFieldVal('ar_total_inelig', totalInelig.toFixed(0));
  setFieldVal('ar_net_eligible', netElig.toFixed(0));

  document.getElementById('kpi-gross-ar').textContent = fmtCurrency(gross);
  document.getElementById('kpi-total-ineligible').textContent = fmtCurrency(totalInelig);
  document.getElementById('kpi-net-eligible').textContent = fmtCurrency(netElig);
  document.getElementById('kpi-ar-avail').textContent = fmtCurrency(avail);
  document.getElementById('kpi-ar-avail-rate').textContent = `at ${rate}% advance`;
}

function recalcBBC() {
  const grossAR = getFieldVal('bbc_gross_ar');
  const ineligAR = getFieldVal('bbc_inelig_ar');
  const netAR = Math.max(0, grossAR - ineligAR);
  const arRate = getFieldVal('bbc_ar_rate') || 85;
  const arAvail = netAR * arRate / 100;

  const grossInv = getFieldVal('bbc_gross_inv');
  const ineligInv = getFieldVal('bbc_inelig_inv');
  const netInv = Math.max(0, grossInv - ineligInv);
  const invRate = getFieldVal('bbc_inv_rate') || 50;
  const invSublimit = getFieldVal('bbc_inv_sublimit');
  const invAvailRaw = netInv * invRate / 100;
  const invAvail = invSublimit > 0 ? Math.min(invAvailRaw, invSublimit) : invAvailRaw;

  const reAvail = getFieldVal('bbc_re_avail');
  const equipAvail = getFieldVal('bbc_equip_avail');
  const totalBB = arAvail + invAvail + reAvail + equipAvail;
  const outstanding = getFieldVal('bbc_outstanding');
  const excess = Math.max(0, totalBB - outstanding);
  const deficiency = Math.max(0, outstanding - totalBB);

  setFieldVal('bbc_net_ar', netAR.toFixed(0));
  setFieldVal('bbc_ar_avail_calc', arAvail.toFixed(0));
  setFieldVal('bbc_net_inv', netInv.toFixed(0));
  setFieldVal('bbc_inv_avail_calc', invAvail.toFixed(0));
  setFieldVal('bbc_total_calc', totalBB.toFixed(0));
  setFieldVal('bbc_excess', excess.toFixed(0));
  setFieldVal('bbc_deficiency', deficiency.toFixed(0));

  document.getElementById('bbc-ar-avail').textContent = fmtCurrency(arAvail);
  document.getElementById('bbc-inv-avail').textContent = fmtCurrency(invAvail);
  document.getElementById('bbc-re-avail').textContent = fmtCurrency(reAvail + equipAvail);
  document.getElementById('bbc-total').textContent = fmtCurrency(totalBB);
}

// ── Version / Snapshot ────────────────────────────────────────────────────────
function saveSnapshot() {
  if (!activeDealId) return;
  saveDeal();
  const deal = deals.find(d => d.id === activeDealId);
  if (!deal) return;
  if (!deal.versions) deal.versions = [];
  const ver = {
    id: uid(),
    num: deal.versions.length + 1,
    ts: new Date().toISOString(),
    label: `v${deal.versions.length + 1} — ${new Date().toLocaleDateString()}`,
    snapshot: JSON.parse(JSON.stringify({ data: deal.data, dynamic: deal.dynamic }))
  };
  deal.versions.push(ver);
  addActivityEntry(`Snapshot saved: ${ver.label}`);
  saveDeals(deals);
  renderVersionList(deal);
}

function renderVersionList(deal) {
  const list = document.getElementById('version-list');
  const empty = document.getElementById('version-empty');
  if (!deal.versions || deal.versions.length === 0) {
    list.innerHTML = ''; empty.style.display = '';
    return;
  }
  empty.style.display = 'none';
  list.innerHTML = [...deal.versions].reverse().map(v => `
    <div class="version-item">
      <div class="ver-num">${escHtml(v.label)}</div>
      <div class="ver-info">
        <div class="ver-date">${new Date(v.ts).toLocaleString()}</div>
      </div>
      <button class="btn btn-secondary btn-sm" onclick="restoreVersion('${v.id}')">Restore</button>
    </div>`).join('');
}

function restoreVersion(verId) {
  const deal = deals.find(d => d.id === activeDealId);
  if (!deal) return;
  const ver = deal.versions.find(v => v.id === verId);
  if (!ver) return;
  if (!confirm(`Restore snapshot "${ver.label}"? Current unsaved changes will be overwritten.`)) return;
  deal.data = JSON.parse(JSON.stringify(ver.snapshot.data));
  deal.dynamic = JSON.parse(JSON.stringify(ver.snapshot.dynamic));
  saveDeals(deals);
  openDeal(deal.id);
  addActivityEntry(`Restored: ${ver.label}`);
}

function addActivityEntry(msg) {
  const deal = deals.find(d => d.id === activeDealId);
  if (!deal) return;
  if (!deal.activityLog) deal.activityLog = [];
  deal.activityLog.push({ ts: new Date().toISOString(), msg });
  saveDeals(deals);
  renderActivityLog(deal);
}

function renderActivityLog(deal) {
  const el = document.getElementById('activity-log');
  if (!deal.activityLog?.length) { el.innerHTML = '<span style="color:var(--gray-4)">No activity yet.</span>'; return; }
  el.innerHTML = [...deal.activityLog].reverse().slice(0, 50).map(e =>
    `<div>${new Date(e.ts).toLocaleString()} — ${escHtml(e.msg)}</div>`).join('');
}

// ══════════════════════════════════════════════════════════════════════════════
// AI EXTRACTION
// ══════════════════════════════════════════════════════════════════════════════

function openAIPanel() {
  if (!activeDealId) { alert('Please open or create a deal first.'); return; }
  document.getElementById('ai-panel').classList.add('open');
}
function closeAIPanel() { document.getElementById('ai-panel').classList.remove('open'); }

// ── File Handling ─────────────────────────────────────────────────────────────
async function handleFiles(files) {
  for (const file of files) {
    const existing = loadedFiles.find(f => f.name === file.name);
    if (existing) continue;
    aiLog(`Loading: ${file.name}`, 'info');
    try {
      const text = await extractTextFromFile(file);
      loadedFiles.push({ name: file.name, type: file.type, text, size: file.size });
      aiLog(`✓ Loaded: ${file.name} (${text.length.toLocaleString()} chars)`, 'success');
    } catch(e) {
      aiLog(`✗ Failed to load ${file.name}: ${e.message}`, 'error');
    }
  }
  renderFileChips();
  document.getElementById('btn-run-extraction').disabled = loadedFiles.length === 0;
}

async function extractTextFromFile(file) {
  const name = file.name.toLowerCase();
  if (name.endsWith('.pdf')) return extractPDF(file);
  if (name.endsWith('.xlsx') || name.endsWith('.xls')) return extractExcel(file);
  if (name.endsWith('.docx') || name.endsWith('.doc')) return extractWord(file);
  throw new Error('Unsupported file type');
}

async function extractPDF(file) {
  const arrayBuffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  let text = '';
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    text += content.items.map(item => item.str).join(' ') + '\n';
  }
  return text;
}

async function extractExcel(file) {
  const arrayBuffer = await file.arrayBuffer();
  const wb = XLSX.read(arrayBuffer, { type: 'array' });
  let text = '';
  wb.SheetNames.forEach(sheetName => {
    const ws = wb.Sheets[sheetName];
    text += `\n[Sheet: ${sheetName}]\n`;
    text += XLSX.utils.sheet_to_csv(ws);
  });
  return text;
}

async function extractWord(file) {
  const arrayBuffer = await file.arrayBuffer();
  const result = await mammoth.extractRawText({ arrayBuffer });
  return result.value;
}

function renderFileChips() {
  const wrap = document.getElementById('uploaded-files-list');
  const chips = document.getElementById('files-chips');
  if (loadedFiles.length === 0) { wrap.style.display = 'none'; return; }
  wrap.style.display = '';
  chips.innerHTML = loadedFiles.map((f, i) =>
    `<span style="display:inline-flex;align-items:center;gap:4px;background:var(--gray-2);padding:4px 10px;border-radius:12px;font-size:12px">
      📄 ${escHtml(f.name)}
      <button onclick="removeFile(${i})" style="background:none;border:none;cursor:pointer;color:var(--gray-4);font-size:14px;padding:0;line-height:1">✕</button>
    </span>`).join('');
}

function removeFile(i) {
  loadedFiles.splice(i, 1);
  renderFileChips();
  document.getElementById('btn-run-extraction').disabled = loadedFiles.length === 0;
}

// ── AI Log ────────────────────────────────────────────────────────────────────
function aiLog(msg, type = 'info') {
  const el = document.getElementById('ai-log');
  const div = document.createElement('div');
  div.className = `log-entry ${type}`;
  div.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
  el.appendChild(div);
  el.scrollTop = el.scrollHeight;
}

function setProgress(pct, label) {
  document.getElementById('extraction-progress-bar').style.width = pct + '%';
  document.getElementById('extraction-pct').textContent = pct + '%';
  if (label) document.getElementById('extraction-status-text').textContent = label;
}

// ── Build extraction prompt ───────────────────────────────────────────────────
function buildExtractionPrompt(target) {
  const targetDesc = target === 'all' ?
    'all relevant sections of an ABL underwriting tool' :
    `the "${target}" section of an ABL underwriting tool`;

  const fieldGuide = `
FIELD MAPPING GUIDE — extract values for these JSON keys when found:
(All dollar amounts as plain numbers. Percentages as plain numbers, e.g. 85 for 85%.)

DEAL OVERVIEW: deal_borrower_name, deal_stage, deal_close_date, deal_rm, deal_uw,
  facility_type, facility_total, facility_ar_sublimit, facility_inv_sublimit,
  ar_advance_rate, inv_advance_rate, rate_base, rate_spread, rate_floor, unused_fee,
  deal_thesis, key_risks, use_of_proceeds

BORROWER: bor_legal_name, bor_entity_type, bor_dba, bor_ein, bor_state_inc,
  bor_hq_state, bor_year_founded, bor_address, bor_industry, bor_naics,
  bor_product, bor_customers, bor_seasonality, mgmt_ceo, mgmt_cfo, mgmt_notes

A/R: ar_gross, ar_aging_cutoff, ar_conc_limit, ar_crossage,
  inelig_over90, inelig_conc, inelig_crossage, inelig_contra, inelig_foreign,
  inelig_govt, inelig_disputed, inelig_unbilled, inelig_other,
  dilution_prior_yr, dilution_ttm, dilution_reserve, dilution_notes, ar_eligibility_notes

INVENTORY: inv_method, inv_obsolete_reserve, inv_notes

FINANCIAL: fin_yr1_label, fin_yr2_label, fin_yr3_label, fin_fy_end,
  fin_revenue_yr1, fin_revenue_yr2, fin_revenue_yr3, fin_revenue_ttm,
  fin_cogs_yr1..yr3..ttm, fin_gross_profit_yr1..yr3..ttm,
  fin_sga_yr1..yr3..ttm, fin_ebitda_yr1..yr3..ttm,
  fin_da_yr1..yr3..ttm, fin_ebit_yr1..yr3..ttm,
  fin_interest_yr1..yr3..ttm, fin_net_income_yr1..yr3..ttm,
  bs_cash_yr1..yr3..interim, bs_ar_yr1..yr3..interim,
  bs_inv_yr1..yr3..interim, bs_tca_yr1..yr3..interim,
  bs_ppe_yr1..yr3..interim, bs_total_assets_yr1..yr3..interim,
  bs_ap_yr1..yr3..interim, bs_ltd_yr1..yr3..interim,
  bs_total_liab_yr1..yr3..interim, bs_equity_yr1..yr3..interim,
  ratio_fccr_yr1, ratio_fccr_yr2, ratio_fccr_ttm,
  ratio_leverage_yr1, ratio_leverage_yr2, ratio_leverage_ttm,
  ratio_current_yr1, ratio_current_yr2, ratio_current_ttm,
  ratio_gm_yr1, ratio_gm_yr2, ratio_gm_ttm,
  ratio_ebitda_margin_yr1, ratio_ebitda_margin_yr2, ratio_ebitda_margin_ttm,
  ratio_dso_yr1, ratio_dso_yr2, ratio_dso_ttm

CREDIT MEMO: memo_exec_summary, memo_biz_description, memo_industry,
  memo_collateral, memo_financial, memo_mgmt, memo_structure, memo_conditions, memo_recommendation

BBC: bbc_gross_ar, bbc_inelig_ar, bbc_ar_rate, bbc_gross_inv,
  bbc_inelig_inv, bbc_inv_rate, bbc_inv_sublimit, bbc_re_avail, bbc_equip_avail, bbc_outstanding

FIELD EXAM: exam_date, exam_examiner, exam_type, exam_scope, exam_assessment, exam_conclusions, exam_reserves
`;

  const docTexts = loadedFiles.map(f =>
    `\n\n${'='.repeat(60)}\nDOCUMENT: ${f.name}\n${'='.repeat(60)}\n${f.text.slice(0, 15000)}`
  ).join('');

  return `You are an expert ABL (Asset-Based Lending) underwriter assistant. Your task is to extract structured data from the provided financial documents and populate ${targetDesc}.

${fieldGuide}

INSTRUCTIONS:
1. Read all documents carefully.
2. Extract as many fields as you can find with confidence.
3. For financial statements, identify the fiscal years and label them correctly.
4. For A/R aging, extract individual customer rows if available as an array.
5. For inventory, extract category rows if available.
6. Return ONLY a valid JSON object. No explanation, no markdown. Just the JSON.
7. Use null for fields you cannot find. Omit fields entirely if not relevant.
8. For arrays (arAging, inventory, owners, debts), use the key "dynamic" with sub-keys.

DOCUMENTS:
${docTexts}

Return a single JSON object with the extracted fields. Example format:
{
  "deal_borrower_name": "ABC Corp",
  "ar_gross": 4500000,
  "fin_revenue_yr1": 12000000,
  "dynamic": {
    "arAging": [{ "customer": "Customer A", "cur": 100000, "d30": 50000, "d60": 0, "d90": 0, "d90p": 0 }],
    "owners": [{ "name": "John Smith", "title": "CEO", "pct": 60, "guarantor": "Yes", "bk": "No" }]
  }
}`;
}

// ── Run Extraction ────────────────────────────────────────────────────────────
async function runExtraction() {
  const key = apiKey();
  if (!key) {
    alert('No API key configured. Go to ⚙ Settings and enter your Anthropic API key, or update config.js.');
    return;
  }
  if (loadedFiles.length === 0) { alert('Please upload at least one document first.'); return; }

  const btn = document.getElementById('btn-run-extraction');
  btn.disabled = true;
  document.getElementById('extraction-progress-wrap').style.display = '';
  document.getElementById('extraction-results').style.display = 'none';
  setProgress(10, 'Sending to AI...');
  aiLog('Starting extraction with Claude AI...', 'info');

  const target = document.getElementById('extract-target').value;
  const prompt = buildExtractionPrompt(target);

  try {
    setProgress(25, 'Waiting for AI response...');
    aiLog(`Sending ${loadedFiles.length} document(s) to Claude...`, 'info');

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true'
      },
      body: JSON.stringify({
        model: typeof CONFIG !== 'undefined' ? CONFIG.MODEL : 'claude-sonnet-4-6',
        max_tokens: typeof CONFIG !== 'undefined' ? CONFIG.MAX_TOKENS : 8192,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    setProgress(75, 'Parsing response...');

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      throw new Error(err.error?.message || `API error ${response.status}`);
    }

    const data = await response.json();
    const rawText = data.content?.[0]?.text || '';
    aiLog('Response received. Parsing JSON...', 'info');

    // Extract JSON from response (handle markdown code blocks)
    const jsonMatch = rawText.match(/```(?:json)?\s*([\s\S]*?)```/) || [null, rawText];
    const jsonStr = jsonMatch[1].trim();
    extractedData = JSON.parse(jsonStr);

    setProgress(100, 'Extraction complete!');
    aiLog(`✓ Extracted ${Object.keys(extractedData).length} top-level fields`, 'success');

    if (extractedData.dynamic) {
      Object.entries(extractedData.dynamic).forEach(([k, v]) => {
        if (Array.isArray(v)) aiLog(`  → ${k}: ${v.length} rows`, 'success');
      });
    }

    // Preview
    const previewData = { ...extractedData };
    delete previewData.dynamic;
    document.getElementById('results-summary').textContent =
      JSON.stringify(previewData, null, 2);
    document.getElementById('extraction-results').style.display = '';

  } catch(e) {
    aiLog(`✗ Extraction failed: ${e.message}`, 'error');
    setProgress(0, 'Failed');
    if (e.message.includes('JSON')) {
      aiLog('Could not parse AI response as JSON. Try again or reduce document size.', 'warn');
    }
  } finally {
    btn.disabled = false;
  }
}

// ── Apply Extraction ──────────────────────────────────────────────────────────
function applyExtraction() {
  if (!extractedData || Object.keys(extractedData).length === 0) return;
  if (!activeDealId) { alert('No deal selected.'); return; }

  let applied = 0;

  // Apply flat fields
  Object.entries(extractedData).forEach(([key, val]) => {
    if (key === 'dynamic') return;
    const el = document.querySelector(`[data-field="${key}"]`);
    if (el && val != null && val !== '') {
      el.value = val;
      el.closest('.field')?.classList.add('ai-filled');
      // Remove highlight after 5s
      setTimeout(() => el.closest('.field')?.classList.remove('ai-filled'), 5000);
      applied++;
    }
  });

  // Apply dynamic table data
  if (extractedData.dynamic) {
    const d = extractedData.dynamic;
    if (d.owners?.length) { dynamicTables.owners = d.owners; renderOwnersTable(); }
    if (d.debts?.length) { dynamicTables.debts = d.debts; renderDebtTable(); }
    if (d.arAging?.length) { dynamicTables.arAging = d.arAging; renderArAgingTable(); }
    if (d.inventory?.length) { dynamicTables.inventory = d.inventory; renderInventoryTable(); }
    if (d.realEstate?.length) { dynamicTables.realEstate = d.realEstate; renderRETable(); }
    if (d.equipment?.length) { dynamicTables.equipment = d.equipment; renderEquipmentTable(); }
    if (d.findings?.length) { dynamicTables.findings = d.findings; renderFindingsTable(); }
    if (d.covenants?.length) { dynamicTables.covenants = d.covenants; renderCovenantTable(); }
  }

  recalcAll();
  saveDeal();
  addActivityEntry(`AI extraction applied: ${applied} fields populated`);
  aiLog(`✓ Applied ${applied} fields to the deal.`, 'success');
  updateDealHeaderBar(deals.find(d => d.id === activeDealId));
  renderDealList();
}
