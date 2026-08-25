import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm'

// This page is wired to the "Triangle IT Support" Supabase project - a
// SEPARATE project from the one Spark's Phone Sync uses, so an employee
// account here has zero access to any personal Spark data. The
// publishable key is meant to be public (Supabase's own docs: "safe to
// use in a browser") - real access control is Row Level Security on the
// tables themselves (see supabase/triangle_it_support_schema.sql).
const SUPABASE_URL = 'https://rtytofraoboczpelvpqi.supabase.co'
const SUPABASE_KEY = 'sb_publishable_IPyRE7yRASw-Mh_jVk5uXA_4ztmmS3H'

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)

// Supabase caps any single request at 1000 rows by default (PostgREST's
// db-max-rows) regardless of how big the table gets - on-screen lists
// page around that interactively (see loadAdminTickets/loadMyTickets:
// "Load more" fetches the next PAGE_SIZE chunk). Places that need a
// TRUE total (the report export, the Dashboard's counts/breakdown) use
// fetchAllRows() below instead, which loops .range() calls until a
// page comes back short, so nothing is ever silently truncated.
const PAGE_SIZE = 100

async function fetchAllRows(queryFactory) {
  let allRows = []
  let from = 0
  while (true) {
    const { data, error } = await queryFactory().range(from, from + PAGE_SIZE - 1)
    if (error) throw error
    allRows = allRows.concat(data)
    if (!data || data.length < PAGE_SIZE) break
    from += PAGE_SIZE
  }
  return allRows
}

const authScreen = document.getElementById('auth-screen')
const appScreen = document.getElementById('app-screen')
const authForm = document.getElementById('auth-form')
const authError = document.getElementById('auth-error')
const authHint = document.getElementById('auth-hint')
const authSubmitBtn = document.getElementById('auth-submit-btn')
const logoutBtn = document.getElementById('logout-btn')
const adminTabBtn = document.getElementById('admin-tab-btn')
const dashboardTabBtn = document.getElementById('dashboard-tab-btn')
const manageTabBtn = document.getElementById('manage-tab-btn')
const loadingOverlay = document.getElementById('loading-overlay')
const userIdentity = document.getElementById('user-identity')

const newCompanySelect = document.getElementById('new-company')
const newDepartmentSelect = document.getElementById('new-department')

function refreshDepartmentOptions() {
  newDepartmentSelect.innerHTML = ''
  const depts = taxonomy.departments_by_company[newCompanySelect.value] || []
  depts.forEach((dept) => {
    const opt = document.createElement('option')
    opt.textContent = dept
    newDepartmentSelect.appendChild(opt)
  })
}

newCompanySelect.addEventListener('change', refreshDepartmentOptions)

let currentUserId = null
let isAdmin = false
let profileEmailById = new Map()

// Company/Department/Category/Office pick-lists - editable by the
// admin from "Manage Lists" (see supabase/triangle_it_support_schema.sql's
// ticket_taxonomy table), loaded fresh on every login rather than
// hardcoded, so a list change is visible to everyone immediately.
let taxonomy = {
  companies: [], departments_by_company: {}, categories: [], offices: [],
  equipment_types: [],
}

async function loadTaxonomy() {
  const { data, error } = await supabase.from('ticket_taxonomy').select('*').eq('id', 1).single()
  if (error) {
    console.error(error)
    return
  }
  taxonomy = {
    companies: data.companies || [],
    departments_by_company: data.departments_by_company || {},
    categories: data.categories || [],
    offices: data.offices || [],
    equipment_types: data.equipment_types || [],
  }
}

async function saveTaxonomy() {
  await supabase.from('ticket_taxonomy').update({
    companies: taxonomy.companies,
    departments_by_company: taxonomy.departments_by_company,
    categories: taxonomy.categories,
    offices: taxonomy.offices,
    equipment_types: taxonomy.equipment_types,
    updated_at: nowIso(),
  }).eq('id', 1)
}

// "Tracked" types (laptop, monitor...) get a Serial Number and live in
// equipment_assets; untracked types (headphones, flash drives...) are
// just logged as handed out in equipment_consumable_log - see the
// equipment_types column comment in the schema file.
function trackedEquipmentTypes() {
  return taxonomy.equipment_types.filter((t) => t.tracked).map((t) => t.name)
}

function untrackedEquipmentTypes() {
  return taxonomy.equipment_types.filter((t) => !t.tracked).map((t) => t.name)
}

function renewalYearsFor(typeName) {
  const entry = taxonomy.equipment_types.find((t) => t.name === typeName)
  return entry ? entry.renewal_years : null
}

function populatePlainSelect(selectEl, options) {
  const current = selectEl.value
  selectEl.innerHTML = ''
  options.forEach((opt) => {
    const o = document.createElement('option')
    o.textContent = opt
    selectEl.appendChild(o)
  })
  if (options.includes(current)) selectEl.value = current
}

function populateFilterSelect(id, options, allLabel) {
  const el = document.getElementById(id)
  const current = el.value
  el.innerHTML = ''
  const allOpt = document.createElement('option')
  allOpt.value = ''
  allOpt.textContent = allLabel
  el.appendChild(allOpt)
  options.forEach((opt) => {
    const o = document.createElement('option')
    o.textContent = opt
    el.appendChild(o)
  })
  if ([...el.options].some((o) => o.value === current)) el.value = current
}

function refreshAllTaxonomyUI() {
  populatePlainSelect(newCompanySelect, taxonomy.companies)
  refreshDepartmentOptions()
  populatePlainSelect(document.getElementById('new-category'), taxonomy.categories)
  populatePlainSelect(document.getElementById('new-office'), taxonomy.offices)

  populateFilterSelect('filter-company', taxonomy.companies, 'All Companies')
  populateFilterSelect('filter-office', taxonomy.offices, 'All Offices')
  populateFilterSelect('filter-category', taxonomy.categories, 'All Categories')

  populateFilterSelect('report-company', taxonomy.companies, 'All Companies')
  populateFilterSelect('report-category', taxonomy.categories, 'All Categories')
  refreshReportDepartmentOptions()

  const allEquipmentTypes = taxonomy.equipment_types.map((t) => t.name)
  populatePlainSelect(document.getElementById('request-equipment-type'), allEquipmentTypes)
  populatePlainSelect(document.getElementById('new-asset-type'), trackedEquipmentTypes())
  populatePlainSelect(document.getElementById('new-consumable-type'), untrackedEquipmentTypes())

  if (isAdmin) {
    renderManageLists()
    populateProfileSelect(document.getElementById('new-consumable-employee'))
    populateLookupEmployeeSelect()
  }
}

// Only active employees, since this populates "assign this equipment
// to..." pickers - an inactive employee shouldn't receive anything
// new (their existing history stays visible elsewhere, e.g. the
// Look Up Employee lookup, which shows everyone).
function populateProfileSelect(selectEl) {
  const current = selectEl.value
  selectEl.innerHTML = ''
  ;[...profileEmailById.entries()]
    .filter(([id]) => profilesById.get(id)?.active !== false)
    .forEach(([id, email]) => {
      const opt = document.createElement('option')
      opt.value = id
      opt.textContent = email
      selectEl.appendChild(opt)
    })
  if ([...selectEl.options].some((o) => o.value === current)) selectEl.value = current
}

// profileEmailById stays a plain id->email lookup, used all over this
// file already; profilesById carries the extra fields (is_admin,
// active) the new Employees & Access panel needs, without touching
// every existing call site that only ever wanted the email.
let profilesById = new Map()

async function loadProfilesMap() {
  const { data } = await supabase.from('profiles').select('id,email,is_admin,active')
  profileEmailById = new Map((data || []).map((p) => [p.id, p.email]))
  profilesById = new Map((data || []).map((p) => [p.id, p]))
}

function nowIso() {
  return new Date().toISOString()
}

function showLoading() { loadingOverlay.classList.remove('hidden') }
function hideLoading() { loadingOverlay.classList.add('hidden') }

function statusClass(status) {
  return 'status-' + (status || 'open').toLowerCase().replace(/\s+/g, '-')
}

// Deliberately different from Spark's own format_ticket_ref() ("T#0007")
// so a ticket that started on the website is recognizable at a glance,
// including later once it's pulled into Spark's Tickets tab (M5).
function ticketRef(ticket) {
  return 'W-T#' + String(ticket.ticket_number).padStart(4, '0')
}

function formatDateTime(iso) {
  return new Date(iso).toLocaleString(undefined, {
    day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit',
  })
}

// ============================== Auth ================================

let authMode = 'signin'

const authTabs = document.getElementById('auth-tabs')
const authPasswordInput = document.getElementById('auth-password')
const forgotPasswordBtn = document.getElementById('forgot-password-btn')
const backToSigninBtn = document.getElementById('back-to-signin-btn')

document.querySelectorAll('.auth-tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.auth-tab-btn').forEach((b) => b.classList.remove('active'))
    btn.classList.add('active')
    authMode = btn.dataset.mode
    authSubmitBtn.textContent = authMode === 'signin' ? 'Sign In' : 'Sign Up'
    authError.textContent = ''
    authHint.classList.add('hidden')
  })
})

function enterResetRequestMode() {
  authMode = 'reset'
  authTabs.classList.add('hidden')
  authPasswordInput.classList.add('hidden')
  authPasswordInput.required = false
  authSubmitBtn.textContent = 'Send Reset Link'
  forgotPasswordBtn.classList.add('hidden')
  backToSigninBtn.classList.remove('hidden')
  authError.textContent = ''
  authHint.classList.add('hidden')
}

function exitResetRequestMode() {
  authMode = 'signin'
  authTabs.classList.remove('hidden')
  authPasswordInput.classList.remove('hidden')
  authPasswordInput.required = true
  authSubmitBtn.textContent = 'Sign In'
  forgotPasswordBtn.classList.remove('hidden')
  backToSigninBtn.classList.add('hidden')
  authError.textContent = ''
  authHint.classList.add('hidden')
  document.querySelectorAll('.auth-tab-btn').forEach((b) => b.classList.toggle('active', b.dataset.mode === 'signin'))
}

forgotPasswordBtn.addEventListener('click', enterResetRequestMode)
backToSigninBtn.addEventListener('click', exitResetRequestMode)

authForm.addEventListener('submit', async (e) => {
  e.preventDefault()
  authError.textContent = ''
  authHint.classList.add('hidden')

  const email = document.getElementById('auth-email').value.trim()

  if (authMode === 'reset') {
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: window.location.origin + window.location.pathname,
    })
    if (error) {
      authError.textContent = error.message
      return
    }
    authHint.textContent = 'Check your email for a password reset link.'
    authHint.classList.remove('hidden')
    return
  }

  const password = authPasswordInput.value

  if (authMode === 'signup') {
    const { error } = await supabase.auth.signUp({ email, password })
    if (error) {
      authError.textContent = error.message
      return
    }
    authHint.textContent = 'Account created — check your email if confirmation is required, then sign in.'
    authHint.classList.remove('hidden')
    return
  }

  const { error } = await supabase.auth.signInWithPassword({ email, password })
  if (error) {
    authError.textContent = error.message
    return
  }

  await enterApp()
})

// Supabase parses the recovery tokens out of the URL on page load (the
// link from the reset email lands back here) and fires this event -
// that's the signal to show the "set a new password" screen instead of
// the normal login.
supabase.auth.onAuthStateChange((event) => {
  if (event === 'PASSWORD_RECOVERY') {
    authScreen.classList.add('hidden')
    appScreen.classList.add('hidden')
    document.getElementById('reset-password-screen').classList.remove('hidden')
  }
})

document.getElementById('new-password-form').addEventListener('submit', async (e) => {
  e.preventDefault()

  const password = document.getElementById('new-password-input').value
  const resetError = document.getElementById('reset-error')
  resetError.textContent = ''

  const { error } = await supabase.auth.updateUser({ password })
  if (error) {
    resetError.textContent = error.message
    return
  }

  document.getElementById('reset-password-screen').classList.add('hidden')
  await enterApp()
})

logoutBtn.addEventListener('click', async () => {
  await supabase.auth.signOut()
  currentUserId = null
  isAdmin = false
  teardownReminderRealtime()
  appScreen.classList.add('hidden')
  authScreen.classList.remove('hidden')
})

async function enterApp() {
  const { data: { session } } = await supabase.auth.getSession()
  if (!session) return

  currentUserId = session.user.id
  userIdentity.textContent = session.user.email

  const { data: profile } = await supabase
    .from('profiles')
    .select('is_admin')
    .eq('id', currentUserId)
    .single()

  isAdmin = !!(profile && profile.is_admin)
  adminTabBtn.classList.toggle('hidden', !isAdmin)
  dashboardTabBtn.classList.toggle('hidden', !isAdmin)
  manageTabBtn.classList.toggle('hidden', !isAdmin)
  document.getElementById('equipment-admin-subtab-btn').classList.toggle('hidden', !isAdmin)
  document.getElementById('notif-bell-wrap').classList.toggle('hidden', !isAdmin)

  authScreen.classList.add('hidden')
  appScreen.classList.remove('hidden')

  if (isAdmin) await loadProfilesMap()

  await loadTaxonomy()
  refreshAllTaxonomyUI()

  loadMyTickets()
  loadMyEquipment()

  if (isAdmin) {
    loadAdminTickets()
    loadDashboard()
    loadAssets()
    loadConsumableLog()
    loadReminders()
    loadEmployeesTable()
    setupReminderRealtime()
  }
}

supabase.auth.getSession().then(({ data }) => {
  if (data.session) enterApp()
})

// ============================== Tabs ================================

document.querySelectorAll('.tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'))
    document.querySelectorAll('.tab-panel').forEach((p) => p.classList.remove('active'))
    btn.classList.add('active')
    document.getElementById('tab-' + btn.dataset.tab).classList.add('active')
  })
})

// Nested tabs inside the Equipment tab (My Equipment vs. Admin
// Management) - same active/hidden toggling as the top-level tabs,
// just scoped to .sub-tab-btn/.sub-tab-panel instead.
document.querySelectorAll('.sub-tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.sub-tab-btn').forEach((b) => b.classList.remove('active'))
    document.querySelectorAll('.sub-tab-panel').forEach((p) => p.classList.remove('active'))
    btn.classList.add('active')
    document.getElementById('equipment-subtab-' + btn.dataset.subtab).classList.add('active')
  })
})

// ============================== Submit ticket ================================

document.getElementById('submit-ticket-form').addEventListener('submit', async (e) => {
  e.preventDefault()

  const title = document.getElementById('new-title').value.trim()
  if (!title) return

  const fields = {
    title,
    description: document.getElementById('new-description').value.trim(),
    company: newCompanySelect.value,
    department: newDepartmentSelect.value,
    category: document.getElementById('new-category').value,
    office: document.getElementById('new-office').value,
    status: 'Open',
    solution: '',
    created_at: nowIso(),
    updated_at: nowIso(),
  }

  showLoading()
  const { error } = await supabase.from('tickets').insert(fields)
  hideLoading()

  if (error) {
    alert('Could not submit ticket: ' + error.message)
    return
  }

  e.target.reset()
  refreshDepartmentOptions()

  const successOverlay = document.getElementById('success-overlay')
  successOverlay.classList.remove('hidden')
  setTimeout(() => {
    successOverlay.classList.add('hidden')
    document.querySelector('.tab-btn[data-tab="mine"]').click()
    loadMyTickets()
  }, 1600)
})

// ============================== My tickets ================================

let mineTickets = []
let minePage = 0
let mineHasMore = true

async function loadMyTickets(reset = true) {
  if (reset) {
    mineTickets = []
    minePage = 0
    mineHasMore = true
  }

  const { data, error } = await supabase
    .from('tickets')
    .select('*')
    .eq('submitted_by', currentUserId)
    .order('updated_at', { ascending: false })
    .range(minePage * PAGE_SIZE, minePage * PAGE_SIZE + PAGE_SIZE - 1)

  if (error) {
    console.error(error)
    return
  }

  mineTickets = mineTickets.concat(data)
  mineHasMore = data.length === PAGE_SIZE
  minePage += 1

  renderTicketList(document.getElementById('mine-list'), mineTickets, false, false, null, true)
  document.getElementById('mine-load-more-btn').classList.toggle('hidden', !mineHasMore)
}

document.getElementById('mine-load-more-btn').addEventListener('click', () => loadMyTickets(false))

// ============================== Admin dashboard ================================

;['filter-status', 'filter-company', 'filter-office', 'filter-category'].forEach((id) => {
  document.getElementById(id).addEventListener('change', () => loadAdminTickets(true))
})

// Own tab (not the filtered "All Tickets" list below) - a stat card
// per status plus the tickets behind that number (same shape as
// Spark's own Dashboard tab). Fetching every ticket just to count them
// client-side was the slow path (confirmed by testing: ~41s at 9,000
// tickets, one page awaited at a time) - counts now come from
// Postgres's own exact-count instead (near-instant regardless of table
// size), previews are small direct per-status queries, and only the
// breakdown genuinely needs every row - fetched with many pages
// in flight at once (bounded, see BREAKDOWN_CONCURRENCY) rather than
// one at a time, since 100-way concurrency was already load-tested
// clean (see the load-test conversation).
const DASHBOARD_PREVIEW = 30
const BREAKDOWN_CONCURRENCY = 50

async function countByStatus(status) {
  const { count, error } = await supabase
    .from('tickets')
    .select('*', { count: 'exact', head: true })
    .eq('status', status)
  if (error) throw error
  return count || 0
}

async function fetchStatusPreview(status) {
  const { data, error } = await supabase
    .from('tickets')
    .select('*')
    .eq('status', status)
    .order('updated_at', { ascending: false })
    .limit(DASHBOARD_PREVIEW)
  if (error) throw error
  return data
}

// Only the columns renderBreakdown() actually groups by - keeps each
// page's payload small on top of fetching pages concurrently.
async function fetchAllSlimForBreakdown(totalCount) {
  const columns = 'status,company,department,category,created_at'
  const pageCount = Math.ceil(totalCount / PAGE_SIZE)
  let allRows = []

  for (let batchStart = 0; batchStart < pageCount; batchStart += BREAKDOWN_CONCURRENCY) {
    const batchEnd = Math.min(batchStart + BREAKDOWN_CONCURRENCY, pageCount)
    const pagePromises = []
    for (let p = batchStart; p < batchEnd; p++) {
      pagePromises.push(
        supabase.from('tickets').select(columns).range(p * PAGE_SIZE, p * PAGE_SIZE + PAGE_SIZE - 1)
      )
    }
    const results = await Promise.all(pagePromises)
    for (const { data, error } of results) {
      if (error) throw error
      allRows = allRows.concat(data)
    }
  }

  return allRows
}

async function loadDashboard() {
  try {
    const [openCount, inProgressCount, resolvedCount] = await Promise.all([
      countByStatus('Open'),
      countByStatus('In Progress'),
      countByStatus('Resolved'),
    ])

    document.getElementById('stat-open').textContent = openCount
    document.getElementById('stat-in-progress').textContent = inProgressCount
    document.getElementById('stat-resolved').textContent = resolvedCount

    const [openPreview, inProgressPreview, resolvedPreview] = await Promise.all([
      fetchStatusPreview('Open'),
      fetchStatusPreview('In Progress'),
      fetchStatusPreview('Resolved'),
    ])

    renderDashboardColumn('dashboard-open-list', openPreview, openCount)
    renderDashboardColumn('dashboard-in-progress-list', inProgressPreview, inProgressCount)
    renderDashboardColumn('dashboard-resolved-list', resolvedPreview, resolvedCount)

    const totalCount = openCount + inProgressCount + resolvedCount
    const slimRows = totalCount > 0 ? await fetchAllSlimForBreakdown(totalCount) : []
    renderBreakdown(slimRows)
  } catch (error) {
    console.error(error)
  }
}

function renderDashboardColumn(listId, previewTickets, totalCount) {
  const listEl = document.getElementById(listId)
  renderTicketList(listEl, previewTickets, false, true, openInAdminTab)

  if (totalCount > previewTickets.length) {
    const note = document.createElement('li')
    note.className = 'empty-hint'
    note.textContent = `Showing ${previewTickets.length} of ${totalCount} — see All Tickets for the rest.`
    listEl.appendChild(note)
  }
}

// Same shape as the summary bar at the top of Spark's own Tickets tab
// (By Company / By Department / By Category / By Month counts) -
// scoped to every ticket, not just the currently-visible dashboard
// columns. countBy() is defined further down (Report export section)
// but function declarations are hoisted, so it's available here too.
function renderBreakdown(tickets) {
  const el = document.getElementById('dashboard-breakdown')
  el.innerHTML = ''

  function line(label, counts) {
    const p = document.createElement('div')
    const strong = document.createElement('strong')
    strong.textContent = label + ': '
    p.appendChild(strong)
    p.append(counts.length ? counts.map(([k, v]) => `${k}: ${v}`).join('   ') : '(none)')
    el.appendChild(p)
  }

  line('By Company', countBy(tickets, (t) => t.company))
  line('By Department', countBy(tickets, (t) => t.department))
  line('By Category', countBy(tickets, (t) => t.category))

  const monthCounts = new Map()
  tickets.forEach((t) => {
    if (!t.created_at) return
    const d = new Date(t.created_at)
    const key = `${d.getMonth() + 1}/${d.getFullYear()}`
    monthCounts.set(key, (monthCounts.get(key) || 0) + 1)
  })
  line('By Month', [...monthCounts.entries()])
}

// Clicking a ticket on the Dashboard jumps to it on the editable "All
// Tickets" tab - reset any active filters first so it's guaranteed to
// be in the (re-fetched) list, then scroll to and briefly flash it.
async function openInAdminTab(ticket) {
  document.querySelector('.tab-btn[data-tab="admin"]').click()

  document.getElementById('filter-status').value = ''
  document.getElementById('filter-company').value = ''
  document.getElementById('filter-office').value = ''
  document.getElementById('filter-category').value = ''
  await loadAdminTickets()

  const card = document.querySelector(`#admin-list [data-ticket-id="${ticket.id}"]`)
  if (!card) return

  card.scrollIntoView({ behavior: 'smooth', block: 'center' })
  card.classList.add('ticket-highlight')
  setTimeout(() => card.classList.remove('ticket-highlight'), 1500)
}

let adminTickets = []
let adminPage = 0
let adminHasMore = true

async function loadAdminTickets(reset = true) {
  if (reset) {
    adminTickets = []
    adminPage = 0
    adminHasMore = true
  }

  let query = supabase.from('tickets').select('*').order('updated_at', { ascending: false })

  const status = document.getElementById('filter-status').value
  const company = document.getElementById('filter-company').value
  const office = document.getElementById('filter-office').value
  const category = document.getElementById('filter-category').value

  if (status) query = query.eq('status', status)
  if (company) query = query.eq('company', company)
  if (office) query = query.eq('office', office)
  if (category) query = query.eq('category', category)

  query = query.range(adminPage * PAGE_SIZE, adminPage * PAGE_SIZE + PAGE_SIZE - 1)

  const { data, error } = await query

  if (error) {
    console.error(error)
    return
  }

  adminTickets = adminTickets.concat(data)
  adminHasMore = data.length === PAGE_SIZE
  adminPage += 1

  renderTicketList(document.getElementById('admin-list'), adminTickets, true, true)
  document.getElementById('admin-load-more-btn').classList.toggle('hidden', !adminHasMore)
}

document.getElementById('admin-load-more-btn').addEventListener('click', () => loadAdminTickets(false))

// ============================== Notification bell ================================
// Admin-only. A ticket counts as a pending reminder while
// reminder_requested_at is set and is newer than reminder_seen_at (or
// reminder_seen_at is still empty) - the same "newer than" comparison
// lets an employee remind again about a ticket the admin already saw
// once, without needing a separate "acknowledged" flag to reset.

const bellBtn = document.getElementById('notif-bell-btn')
const notifDropdown = document.getElementById('notif-dropdown')
const notifBadge = document.getElementById('notif-badge')
const notifList = document.getElementById('notif-list')

let reminderChannel = null

async function loadReminders() {
  if (!isAdmin) return

  const { data, error } = await supabase
    .from('tickets')
    .select('*')
    .not('reminder_requested_at', 'is', null)
    .order('reminder_requested_at', { ascending: false })

  if (error) {
    console.error(error)
    return
  }

  const pending = data.filter((t) =>
    !t.reminder_seen_at || t.reminder_seen_at < t.reminder_requested_at
  )

  renderNotifDropdown(pending)
}

function renderNotifDropdown(pending) {
  notifBadge.textContent = pending.length
  notifBadge.classList.toggle('hidden', pending.length === 0)

  notifList.innerHTML = ''
  if (pending.length === 0) {
    const li = document.createElement('li')
    li.className = 'empty-hint'
    li.textContent = 'No reminders.'
    notifList.appendChild(li)
    return
  }

  pending.forEach((ticket) => {
    const li = document.createElement('li')
    li.className = 'notif-item'
    li.textContent = `${ticketRef(ticket)} — ${ticket.title}`
    li.addEventListener('click', () => acknowledgeReminder(ticket))
    notifList.appendChild(li)
  })
}

async function acknowledgeReminder(ticket) {
  notifDropdown.classList.add('hidden')
  await supabase.from('tickets').update({ reminder_seen_at: nowIso() }).eq('id', ticket.id)
  await openInAdminTab(ticket)
  loadReminders()
}

bellBtn.addEventListener('click', (e) => {
  e.stopPropagation()
  notifDropdown.classList.toggle('hidden')
})

document.addEventListener('click', (e) => {
  if (!notifDropdown.contains(e.target) && e.target !== bellBtn) {
    notifDropdown.classList.add('hidden')
  }
})

function setupReminderRealtime() {
  if (reminderChannel) return
  reminderChannel = supabase
    .channel('tickets-reminders')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'tickets' }, () => loadReminders())
    .subscribe()
}

function teardownReminderRealtime() {
  if (reminderChannel) {
    supabase.removeChannel(reminderChannel)
    reminderChannel = null
  }
}

// ============================== Rendering ================================

function renderTicketList(listEl, tickets, adminMode, showRequester, onCardClick, showRemindButton) {
  listEl.innerHTML = ''

  if (tickets.length === 0) {
    const li = document.createElement('li')
    li.className = 'empty-hint'
    li.textContent = 'No tickets yet.'
    listEl.appendChild(li)
    return
  }

  tickets.forEach((ticket) => {
    const li = document.createElement('li')
    li.className = 'ticket-card'
    li.dataset.ticketId = ticket.id

    if (onCardClick) {
      li.classList.add('clickable')
      li.addEventListener('click', () => onCardClick(ticket))
    }

    const top = document.createElement('div')
    top.className = 'ticket-card-top'

    const left = document.createElement('div')
    const title = document.createElement('div')
    title.className = 'ticket-title'
    title.textContent = `${ticketRef(ticket)} — ${ticket.title}`
    left.appendChild(title)

    const meta = document.createElement('div')
    meta.className = 'ticket-meta'
    meta.textContent = [
      formatDateTime(ticket.created_at),
      showRequester ? (profileEmailById.get(ticket.submitted_by) || 'Unknown submitter') : null,
      ticket.company, ticket.department, ticket.category, ticket.office,
    ].filter(Boolean).join(' · ')
    left.appendChild(meta)

    top.appendChild(left)

    const badge = document.createElement('span')
    badge.className = 'status-badge ' + statusClass(ticket.status)
    badge.textContent = ticket.status
    top.appendChild(badge)

    li.appendChild(top)

    if (ticket.description) {
      const desc = document.createElement('div')
      desc.className = 'ticket-desc'
      desc.textContent = ticket.description
      li.appendChild(desc)
    }

    if (!adminMode && ticket.solution) {
      const sol = document.createElement('div')
      sol.className = 'ticket-solution'
      sol.textContent = 'Solution: ' + ticket.solution
      li.appendChild(sol)
    }

    if (showRemindButton && ticket.status !== 'Resolved') {
      const remindBtn = document.createElement('button')
      remindBtn.type = 'button'
      remindBtn.className = 'remind-btn'
      const alreadyPending = ticket.reminder_requested_at &&
        (!ticket.reminder_seen_at || ticket.reminder_seen_at < ticket.reminder_requested_at)
      remindBtn.textContent = alreadyPending ? '🔔 Reminded' : '🔔 Remind Admin'
      remindBtn.disabled = !!alreadyPending
      remindBtn.addEventListener('click', async (ev) => {
        ev.stopPropagation()
        remindBtn.disabled = true
        remindBtn.textContent = 'Reminding...'
        const { error } = await supabase.rpc('request_ticket_reminder', { ticket_id: ticket.id })
        remindBtn.textContent = error ? '🔔 Remind Admin' : '🔔 Reminded'
        remindBtn.disabled = !error
        if (error) console.error(error)
      })
      li.appendChild(remindBtn)
    }

    if (adminMode) {
      const controls = document.createElement('div')
      controls.className = 'admin-controls'

      const statusSelect = document.createElement('select')
      ;['Open', 'In Progress', 'Resolved'].forEach((s) => {
        const opt = document.createElement('option')
        opt.value = s
        opt.textContent = s
        opt.selected = s === ticket.status
        statusSelect.appendChild(opt)
      })

      const solutionInput = document.createElement('textarea')
      solutionInput.rows = 1
      solutionInput.placeholder = 'Solution / notes...'
      solutionInput.value = ticket.solution || ''

      const saveBtn = document.createElement('button')
      saveBtn.textContent = 'Save'
      saveBtn.addEventListener('click', () => updateTicket(ticket.id, statusSelect.value, solutionInput.value))

      controls.append(statusSelect, solutionInput, saveBtn)
      li.appendChild(controls)
    }

    listEl.appendChild(li)
  })
}

// ============================== Report export ================================

const reportCompanySelect = document.getElementById('report-company')
const reportDepartmentSelect = document.getElementById('report-department')

function refreshReportDepartmentOptions() {
  const company = reportCompanySelect.value
  const companies = company ? [company] : taxonomy.companies

  const options = []
  companies.forEach((c) => {
    ;(taxonomy.departments_by_company[c] || []).forEach((d) => {
      if (!options.includes(d)) options.push(d)
    })
  })

  reportDepartmentSelect.innerHTML = '<option value="">All Departments</option>'
  options.forEach((d) => {
    const opt = document.createElement('option')
    opt.textContent = d
    reportDepartmentSelect.appendChild(opt)
  })
}

reportCompanySelect.addEventListener('change', refreshReportDepartmentOptions)

const UNSET_LABEL = 'Unset'

// Same palette as Spark's own ticket report (services/ticket_report.py).
const STATUS_FILL_COLORS = { Open: '2F6FED', 'In Progress': 'D9A441', Resolved: '3ECF8E' }
const HEADER_FONT = { bold: true, color: { rgb: 'FFFFFF' } }
const HEADER_FILL = { fgColor: { rgb: '303030' } }
const SECTION_FONT = { bold: true, sz: 12 }

function styleCell(sheet, row, col, style) {
  const ref = XLSX.utils.encode_cell({ r: row, c: col })
  if (!sheet[ref]) sheet[ref] = { t: 's', v: '' }
  sheet[ref].s = { ...(sheet[ref].s || {}), ...style }
}

function countBy(tickets, keyFn) {
  const counts = new Map()
  tickets.forEach((t) => {
    const key = keyFn(t) || UNSET_LABEL
    counts.set(key, (counts.get(key) || 0) + 1)
  })
  return [...counts.entries()].sort((a, b) => b[1] - a[1])
}

document.getElementById('export-report-btn').addEventListener('click', async () => {
  const fromStr = document.getElementById('report-from').value
  const toStr = document.getElementById('report-to').value

  if (!fromStr || !toStr) {
    alert('Pick both a From and To date.')
    return
  }
  if (fromStr > toStr) {
    alert('"From" must be on or before "To".')
    return
  }

  const status = document.getElementById('report-status').value
  const company = reportCompanySelect.value
  const department = reportDepartmentSelect.value
  const category = document.getElementById('report-category').value

  let tickets
  try {
    tickets = await fetchAllRows(() => {
      let query = supabase
        .from('tickets')
        .select('*')
        .gte('created_at', fromStr + 'T00:00:00')
        .lte('created_at', toStr + 'T23:59:59')
        .order('created_at', { ascending: true })

      if (status) query = query.eq('status', status)
      if (company) query = query.eq('company', company)
      if (department) query = query.eq('department', department)
      if (category) query = query.eq('category', category)

      return query
    })
  } catch (error) {
    alert('Could not build report: ' + error.message)
    return
  }

  const { data: profiles } = await supabase.from('profiles').select('id,email')
  const emailById = new Map((profiles || []).map((p) => [p.id, p.email]))

  const wb = XLSX.utils.book_new()

  // ---- Summary sheet ----
  const filtersText = [
    status && `Status: ${status}`,
    company && `Company: ${company}`,
    department && `Department: ${department}`,
    category && `Category: ${category}`,
  ].filter(Boolean).join(' | ') || 'None'

  const monthCounts = new Map()
  tickets.forEach((t) => {
    if (!t.created_at) return
    const d = new Date(t.created_at)
    const key = `${d.getMonth() + 1}/${d.getFullYear()}`
    monthCounts.set(key, (monthCounts.get(key) || 0) + 1)
  })

  const sectionStarts = []
  let totalRow = 0

  const summaryRows = [
    ['Tickets Report Summary'],
    [`Date range (created): ${fromStr} to ${toStr}`],
    [`Filters: ${filtersText}`],
    [`Total tickets: ${tickets.length}`],
    [],
  ]
  totalRow = 3

  ;[
    ['By Company', countBy(tickets, (t) => t.company)],
    ['By Department', countBy(tickets, (t) => t.department)],
    ['By Category', countBy(tickets, (t) => t.category)],
    ['By Status', countBy(tickets, (t) => t.status)],
    ['By Month', [...monthCounts.entries()]],
  ].forEach(([label, items]) => {
    sectionStarts.push(summaryRows.length)
    summaryRows.push([label])
    if (items.length === 0) summaryRows.push(['(none)'])
    else items.forEach((row) => summaryRows.push(row))
    summaryRows.push([])
  })

  const summarySheet = XLSX.utils.aoa_to_sheet(summaryRows)
  summarySheet['!cols'] = [{ wch: 26 }, { wch: 12 }]

  styleCell(summarySheet, 0, 0, { font: { bold: true, sz: 14 } })
  styleCell(summarySheet, totalRow, 0, { font: { bold: true } })
  sectionStarts.forEach((row) => styleCell(summarySheet, row, 0, SECTION_FONT))

  XLSX.utils.book_append_sheet(wb, summarySheet, 'Summary')

  // ---- Detailed sheet ----
  const detailHeader = [
    'Ref', 'Title', 'Submitted By', 'Status', 'Company', 'Department',
    'Category', 'Office', 'Created', 'Updated', 'Resolved', 'Description', 'Solution',
  ]
  const detailRows = tickets.map((t) => [
    ticketRef(t),
    t.title,
    emailById.get(t.submitted_by) || '',
    t.status,
    t.company || '',
    t.department || '',
    t.category || '',
    t.office || '',
    formatDateTime(t.created_at),
    formatDateTime(t.updated_at),
    t.resolved_at ? formatDateTime(t.resolved_at) : '',
    t.description || '',
    t.solution || '',
  ])

  const detailSheet = XLSX.utils.aoa_to_sheet([detailHeader, ...detailRows])
  detailSheet['!cols'] = [
    { wch: 12 }, { wch: 36 }, { wch: 22 }, { wch: 12 }, { wch: 10 }, { wch: 18 },
    { wch: 10 }, { wch: 10 }, { wch: 16 }, { wch: 16 }, { wch: 16 }, { wch: 44 }, { wch: 44 },
  ]
  detailSheet['!freeze'] = { xSplit: 0, ySplit: 1 }

  const STATUS_COL = 3 // 0-indexed: Ref,Title,Submitted By,Status
  const WRAP_COLS = [1, 11, 12] // Title, Description, Solution

  detailHeader.forEach((_, col) => {
    styleCell(detailSheet, 0, col, { font: HEADER_FONT, fill: { patternType: 'solid', ...HEADER_FILL } })
  })

  detailRows.forEach((row, rowIndex) => {
    const r = rowIndex + 1
    row.forEach((_, col) => {
      styleCell(detailSheet, r, col, {
        alignment: { vertical: 'top', wrapText: WRAP_COLS.includes(col) },
      })
    })

    const fillColor = STATUS_FILL_COLORS[row[STATUS_COL]]
    if (fillColor) {
      styleCell(detailSheet, r, STATUS_COL, {
        font: { color: { rgb: 'FFFFFF' }, bold: true },
        fill: { patternType: 'solid', fgColor: { rgb: fillColor } },
      })
    }
  })

  XLSX.utils.book_append_sheet(wb, detailSheet, 'Detailed')

  XLSX.writeFile(wb, `Tickets_Report_${fromStr}_to_${toStr}.xlsx`)
})

async function updateTicket(id, status, solution) {
  const fields = { status, solution, updated_at: nowIso() }
  if (status === 'Resolved') fields.resolved_at = nowIso()

  const { error } = await supabase.from('tickets').update(fields).eq('id', id)
  if (error) {
    alert('Could not update ticket: ' + error.message)
    return
  }
  loadAdminTickets()
  loadDashboard()
}

// ============================== Manage Lists ================================

const manageDeptCompanySelect = document.getElementById('manage-dept-company')

function renderChipList(containerId, items, onRemove) {
  const container = document.getElementById(containerId)
  container.innerHTML = ''

  if (items.length === 0) {
    const empty = document.createElement('span')
    empty.className = 'hint-text'
    empty.textContent = 'None yet.'
    container.appendChild(empty)
    return
  }

  items.forEach((item) => {
    const chip = document.createElement('span')
    chip.className = 'chip'
    chip.append(document.createTextNode(item))

    const removeBtn = document.createElement('button')
    removeBtn.type = 'button'
    removeBtn.textContent = '×'
    removeBtn.title = 'Remove'
    removeBtn.addEventListener('click', () => onRemove(item))
    chip.appendChild(removeBtn)

    container.appendChild(chip)
  })
}

function renderDepartmentChips() {
  const company = manageDeptCompanySelect.value
  const depts = taxonomy.departments_by_company[company] || []
  renderChipList('manage-departments', depts, (name) => removeDepartment(company, name))
}

function renderManageLists() {
  renderChipList('manage-companies', taxonomy.companies, removeCompany)
  renderChipList('manage-categories', taxonomy.categories, (name) => removeSimple('categories', name))
  renderChipList('manage-offices', taxonomy.offices, (name) => removeSimple('offices', name))

  populatePlainSelect(manageDeptCompanySelect, taxonomy.companies)
  renderDepartmentChips()

  renderEquipmentTypesTable()
}

function renderEquipmentTypesTable() {
  const tbody = document.querySelector('#manage-equipment-types tbody')
  tbody.innerHTML = ''

  taxonomy.equipment_types.forEach((entry, index) => {
    const tr = document.createElement('tr')

    const nameTd = document.createElement('td')
    nameTd.textContent = entry.name
    tr.appendChild(nameTd)

    const trackedTd = document.createElement('td')
    trackedTd.textContent = entry.tracked ? 'Yes' : 'No'
    tr.appendChild(trackedTd)

    const yearsTd = document.createElement('td')
    yearsTd.textContent = entry.tracked ? (entry.renewal_years ?? '—') : '—'
    tr.appendChild(yearsTd)

    const removeTd = document.createElement('td')
    const removeBtn = document.createElement('button')
    removeBtn.type = 'button'
    removeBtn.textContent = '×'
    removeBtn.title = 'Remove'
    removeBtn.addEventListener('click', () => removeEquipmentType(index))
    removeTd.appendChild(removeBtn)
    tr.appendChild(removeTd)

    tbody.appendChild(tr)
  })
}

async function removeEquipmentType(index) {
  taxonomy.equipment_types.splice(index, 1)
  await saveTaxonomy()
  refreshAllTaxonomyUI()
}

document.getElementById('add-equipment-type-form').addEventListener('submit', async (e) => {
  e.preventDefault()

  const nameInput = document.getElementById('new-equipment-type-name')
  const trackedInput = document.getElementById('new-equipment-type-tracked')
  const yearsInput = document.getElementById('new-equipment-type-years')

  const name = nameInput.value.trim()
  if (!name || taxonomy.equipment_types.some((t) => t.name === name)) return

  const tracked = trackedInput.checked
  const years = yearsInput.value ? Number(yearsInput.value) : null

  taxonomy.equipment_types.push({ name, tracked, renewal_years: tracked ? years : null })

  nameInput.value = ''
  yearsInput.value = ''
  trackedInput.checked = true

  await saveTaxonomy()
  refreshAllTaxonomyUI()
})

manageDeptCompanySelect.addEventListener('change', renderDepartmentChips)

async function removeSimple(listKey, value) {
  taxonomy[listKey] = taxonomy[listKey].filter((v) => v !== value)
  await saveTaxonomy()
  refreshAllTaxonomyUI()
}

async function removeCompany(name) {
  taxonomy.companies = taxonomy.companies.filter((c) => c !== name)
  delete taxonomy.departments_by_company[name]
  await saveTaxonomy()
  refreshAllTaxonomyUI()
}

async function removeDepartment(company, name) {
  taxonomy.departments_by_company[company] = (taxonomy.departments_by_company[company] || []).filter((d) => d !== name)
  await saveTaxonomy()
  refreshAllTaxonomyUI()
}

function wireAddForm(formId, listKey) {
  document.getElementById(formId).addEventListener('submit', async (e) => {
    e.preventDefault()
    const input = e.target.querySelector('input')
    const value = input.value.trim()
    if (!value || taxonomy[listKey].includes(value)) return

    taxonomy[listKey].push(value)
    if (listKey === 'companies' && !taxonomy.departments_by_company[value]) {
      taxonomy.departments_by_company[value] = []
    }

    input.value = ''
    await saveTaxonomy()
    refreshAllTaxonomyUI()
  })
}

wireAddForm('add-company-form', 'companies')
wireAddForm('add-category-form', 'categories')
wireAddForm('add-office-form', 'offices')

document.getElementById('add-department-form').addEventListener('submit', async (e) => {
  e.preventDefault()

  const company = manageDeptCompanySelect.value
  if (!company) return

  const input = e.target.querySelector('input')
  const value = input.value.trim()
  if (!value) return

  if (!taxonomy.departments_by_company[company]) taxonomy.departments_by_company[company] = []
  if (taxonomy.departments_by_company[company].includes(value)) return

  taxonomy.departments_by_company[company].push(value)
  input.value = ''
  await saveTaxonomy()
  refreshAllTaxonomyUI()
})

// ============================== Equipment ================================
// Requesting equipment never auto-creates an equipment_assets row - an
// admin fulfills a request by assigning an existing Unassigned asset
// (or logging a consumable handout) from the panel below, keeping
// equipment_assets the single source of truth for what physically
// exists (see the schema file's comment on equipment_requests).

function renewalDue(assignedAtStr, typeName) {
  const years = renewalYearsFor(typeName)
  if (!assignedAtStr || !years) return false
  const dueDate = new Date(assignedAtStr)
  dueDate.setFullYear(dueDate.getFullYear() + years)
  return dueDate <= new Date()
}

function simpleCard(lines, extraClass) {
  const li = document.createElement('li')
  li.className = 'ticket-card' + (extraClass ? ' ' + extraClass : '')
  lines.forEach((line, i) => {
    const div = document.createElement('div')
    div.className = i === 0 ? 'ticket-title' : 'ticket-meta'
    div.textContent = line
    li.appendChild(div)
  })
  return li
}

function renderEmptyList(listEl, text) {
  listEl.innerHTML = ''
  const li = document.createElement('li')
  li.className = 'empty-hint'
  li.textContent = text
  listEl.appendChild(li)
}

// --- Employee: request form + "mine" lists ---

document.getElementById('equipment-request-form').addEventListener('submit', async (e) => {
  e.preventDefault()

  const type = document.getElementById('request-equipment-type').value
  const reason = document.getElementById('request-equipment-reason').value.trim()
  if (!type) return

  const { error } = await supabase.from('equipment_requests').insert({
    type, reason, status: 'Pending', created_at: nowIso(), updated_at: nowIso(),
  })

  if (error) {
    alert('Could not send request: ' + error.message)
    return
  }

  e.target.reset()
  loadMyEquipment()
})

// Shared by "My ..." (the logged-in employee's own history) and the
// admin's "Look Up an Employee's Equipment" lookup below - same three
// lists, just scoped to whichever profileId is passed in.
async function renderEquipmentHistoryFor(profileId, listIds) {
  const [{ data: requests }, { data: assets }, { data: consumables }] = await Promise.all([
    supabase.from('equipment_requests').select('*').eq('requested_by', profileId).order('created_at', { ascending: false }),
    supabase.from('equipment_assets').select('*').eq('assigned_to', profileId).order('assigned_at', { ascending: false }),
    supabase.from('equipment_consumable_log').select('*').eq('given_to', profileId).order('given_at', { ascending: false }),
  ])

  const requestsList = document.getElementById(listIds.requests)
  requestsList.innerHTML = ''
  if (!requests || requests.length === 0) {
    renderEmptyList(requestsList, 'No requests yet.')
  } else {
    requests.forEach((r) => {
      requestsList.appendChild(simpleCard([
        `${r.type} — ${r.status}`,
        [formatDateTime(r.created_at), r.reason].filter(Boolean).join(' · '),
      ]))
    })
  }

  const assetsList = document.getElementById(listIds.assets)
  assetsList.innerHTML = ''
  if (!assets || assets.length === 0) {
    renderEmptyList(assetsList, 'No equipment assigned.')
  } else {
    assets.forEach((a) => {
      const due = renewalDue(a.assigned_at, a.type)
      assetsList.appendChild(simpleCard([
        `${a.type}${a.model ? ' — ' + a.model : ''}${due ? ' (renewal due)' : ''}`,
        [
          a.serial_number ? 'S/N ' + a.serial_number : null,
          a.assigned_at ? 'Since ' + a.assigned_at : null,
          a.warranty_until ? 'Warranty until ' + a.warranty_until : null,
        ].filter(Boolean).join(' · '),
      ], due ? 'ticket-highlight' : ''))
    })
  }

  const consumablesList = document.getElementById(listIds.consumables)
  consumablesList.innerHTML = ''
  if (!consumables || consumables.length === 0) {
    renderEmptyList(consumablesList, 'None received yet.')
  } else {
    consumables.forEach((c) => {
      consumablesList.appendChild(simpleCard([
        `${c.type} × ${c.quantity}`,
        c.given_at,
      ]))
    })
  }
}

const MY_EQUIPMENT_LIST_IDS = { requests: 'my-requests-list', assets: 'my-assets-list', consumables: 'my-consumables-list' }

async function loadMyEquipment() {
  await renderEquipmentHistoryFor(currentUserId, MY_EQUIPMENT_LIST_IDS)
}

// --- Admin: look up an employee's equipment ---

const LOOKUP_LIST_IDS = { requests: 'lookup-requests-list', assets: 'lookup-assets-list', consumables: 'lookup-consumables-list' }

function populateLookupEmployeeSelect() {
  const selectEl = document.getElementById('lookup-employee-select')
  const current = selectEl.value
  selectEl.innerHTML = '<option value="">Select an employee...</option>'
  ;[...profileEmailById.entries()].forEach(([id, email]) => {
    const opt = document.createElement('option')
    opt.value = id
    opt.textContent = email + (profilesById.get(id)?.active === false ? ' (inactive)' : '')
    selectEl.appendChild(opt)
  })
  if ([...selectEl.options].some((o) => o.value === current)) selectEl.value = current
}

document.getElementById('lookup-employee-select').addEventListener('change', (e) => {
  const profileId = e.target.value
  if (!profileId) {
    ;['lookup-requests-list', 'lookup-assets-list', 'lookup-consumables-list'].forEach((id) => {
      renderEmptyList(document.getElementById(id), 'Select an employee above.')
    })
    return
  }
  renderEquipmentHistoryFor(profileId, LOOKUP_LIST_IDS)
})

// --- Admin: equipment overview stats ---

async function loadEquipmentOverview() {
  const unassigned = assetsCache.filter((a) => a.status === 'Unassigned').length
  const assignedAssets = assetsCache.filter((a) => a.status === 'Assigned')
  const retired = assetsCache.filter((a) => a.status === 'Retired').length
  const due = assignedAssets.filter((a) => renewalDue(a.assigned_at, a.type)).length

  document.getElementById('eq-stat-total').textContent = assetsCache.length
  document.getElementById('eq-stat-unassigned').textContent = unassigned
  document.getElementById('eq-stat-assigned').textContent = assignedAssets.length
  document.getElementById('eq-stat-retired').textContent = retired
  document.getElementById('eq-stat-due').textContent = due

  const [{ count: consumablesCount }, { count: pendingCount }] = await Promise.all([
    supabase.from('equipment_consumable_log').select('*', { count: 'exact', head: true }),
    supabase.from('equipment_requests').select('*', { count: 'exact', head: true }).eq('status', 'Pending'),
  ])

  const breakdown = document.getElementById('equipment-breakdown')
  breakdown.innerHTML = ''

  function line(label, counts) {
    const p = document.createElement('div')
    const strong = document.createElement('strong')
    strong.textContent = label + ': '
    p.appendChild(strong)
    p.append(counts.length ? counts.map(([k, v]) => `${k}: ${v}`).join('   ') : '(none)')
    breakdown.appendChild(p)
  }

  line('By Type', countBy(assetsCache, (a) => a.type))
  line('Consumables logged (total)', [['Count', consumablesCount || 0]])
  line('Pending requests', [['Count', pendingCount || 0]])
}

// --- Admin: requests ---

let assetsCache = []

async function loadAllRequests() {
  const { data, error } = await supabase
    .from('equipment_requests')
    .select('*')
    .order('created_at', { ascending: false })

  if (error) {
    console.error(error)
    return
  }

  const sorted = [...data].sort((a, b) => (a.status === 'Pending' ? -1 : 0) - (b.status === 'Pending' ? -1 : 0))
  renderRequestsList(sorted)

  // Runs after assetsCache is already fresh, whether this call came
  // from loadAssets()'s tail or directly (e.g. declineRequest()) - see
  // loadEquipmentOverview()'s use of assetsCache.
  loadEquipmentOverview()
}

function renderRequestsList(requests) {
  const listEl = document.getElementById('admin-requests-list')
  listEl.innerHTML = ''

  if (requests.length === 0) {
    renderEmptyList(listEl, 'No requests yet.')
    return
  }

  requests.forEach((r) => {
    const li = document.createElement('li')
    li.className = 'ticket-card'

    const title = document.createElement('div')
    title.className = 'ticket-title'
    title.textContent = `${r.type} — ${r.status}`
    li.appendChild(title)

    const meta = document.createElement('div')
    meta.className = 'ticket-meta'
    meta.textContent = [
      formatDateTime(r.created_at),
      profileEmailById.get(r.requested_by) || 'Unknown',
      r.reason,
    ].filter(Boolean).join(' · ')
    li.appendChild(meta)

    if (r.status === 'Pending') {
      const controls = document.createElement('div')
      controls.className = 'admin-controls'

      const availableAssets = assetsCache.filter((a) => a.type === r.type && a.status === 'Unassigned')
      const assetSelect = document.createElement('select')
      if (availableAssets.length === 0) {
        const opt = document.createElement('option')
        opt.textContent = 'No unassigned ' + r.type + ' available'
        opt.disabled = true
        assetSelect.appendChild(opt)
      } else {
        availableAssets.forEach((a) => {
          const opt = document.createElement('option')
          opt.value = a.id
          opt.textContent = `${a.model || a.type}${a.serial_number ? ' (S/N ' + a.serial_number + ')' : ''}`
          assetSelect.appendChild(opt)
        })
      }

      const fulfillBtn = document.createElement('button')
      fulfillBtn.textContent = 'Fulfill'
      fulfillBtn.disabled = availableAssets.length === 0
      fulfillBtn.addEventListener('click', () => fulfillRequest(r, assetSelect.value))

      const declineBtn = document.createElement('button')
      declineBtn.textContent = 'Decline'
      declineBtn.addEventListener('click', () => declineRequest(r))

      controls.append(assetSelect, fulfillBtn, declineBtn)
      li.appendChild(controls)
    }

    listEl.appendChild(li)
  })
}

async function fulfillRequest(request, assetId) {
  if (!assetId) return

  const { error: assetError } = await supabase.from('equipment_assets').update({
    status: 'Assigned', assigned_to: request.requested_by, assigned_at: new Date().toISOString().slice(0, 10),
    updated_at: nowIso(),
  }).eq('id', assetId)

  if (assetError) {
    alert('Could not assign asset: ' + assetError.message)
    return
  }

  await supabase.from('equipment_requests').update({
    status: 'Fulfilled', fulfilled_asset_id: assetId, updated_at: nowIso(),
  }).eq('id', request.id)

  loadAssets() // also refreshes the requests list (see loadAssets())
}

async function declineRequest(request) {
  await supabase.from('equipment_requests').update({ status: 'Declined', updated_at: nowIso() }).eq('id', request.id)
  loadAllRequests()
}

// --- Admin: IT Assets inventory ---

async function loadAssets() {
  const { data, error } = await supabase.from('equipment_assets').select('*').order('created_at', { ascending: false })
  if (error) {
    console.error(error)
    return
  }
  assetsCache = data
  renderAssetsList(data)
  loadAllRequests()
}

function renderAssetsList(assets) {
  const listEl = document.getElementById('admin-assets-list')
  listEl.innerHTML = ''

  if (assets.length === 0) {
    renderEmptyList(listEl, 'No assets yet.')
    return
  }

  assets.forEach((a) => {
    const due = renewalDue(a.assigned_at, a.type)
    const warrantyExpired = a.warranty_until && a.warranty_until < new Date().toISOString().slice(0, 10)
    const li = document.createElement('li')
    li.className = 'ticket-card' + (due ? ' ticket-highlight' : '')

    const title = document.createElement('div')
    title.className = 'ticket-title'
    title.textContent = `${a.type}${a.model ? ' — ' + a.model : ''} (${a.status}${due ? ', renewal due' : ''})`
    li.appendChild(title)

    const meta = document.createElement('div')
    meta.className = 'ticket-meta'
    meta.textContent = [
      a.serial_number ? 'S/N ' + a.serial_number : null,
      a.assigned_to ? (profileEmailById.get(a.assigned_to) || 'Unknown') : null,
      a.assigned_at,
      a.warranty_until ? `Warranty until ${a.warranty_until}${warrantyExpired ? ' (expired)' : ''}` : null,
    ].filter(Boolean).join(' · ')
    li.appendChild(meta)

    const controls = document.createElement('div')
    controls.className = 'admin-controls'

    if (a.status !== 'Retired') {
      if (a.status === 'Unassigned') {
        const assignSelect = document.createElement('select')
        populateProfileSelect(assignSelect)
        const assignBtn = document.createElement('button')
        assignBtn.textContent = 'Assign'
        assignBtn.addEventListener('click', () => assignAsset(a.id, assignSelect.value))
        controls.append(assignSelect, assignBtn)
      } else {
        // "Take Back" and "Retire" sit side by side here on purpose -
        // taking an assigned item back from an employee can go either
        // way: back into the Unassigned pool for reassignment, or
        // straight to Retired if it's not going to anyone else.
        const takeBackBtn = document.createElement('button')
        takeBackBtn.textContent = 'Take Back'
        takeBackBtn.addEventListener('click', () => unassignAsset(a.id))
        controls.append(takeBackBtn)
      }

      const retireBtn = document.createElement('button')
      retireBtn.textContent = 'Retire'
      retireBtn.addEventListener('click', () => retireAsset(a.id))
      controls.append(retireBtn)
    }

    li.appendChild(controls)
    listEl.appendChild(li)
  })
}

async function assignAsset(assetId, profileId) {
  if (!profileId) return
  await supabase.from('equipment_assets').update({
    status: 'Assigned', assigned_to: profileId, assigned_at: new Date().toISOString().slice(0, 10), updated_at: nowIso(),
  }).eq('id', assetId)
  loadAssets()
}

async function unassignAsset(assetId) {
  await supabase.from('equipment_assets').update({
    status: 'Unassigned', assigned_to: null, assigned_at: null, updated_at: nowIso(),
  }).eq('id', assetId)
  loadAssets()
}

async function retireAsset(assetId) {
  await supabase.from('equipment_assets').update({ status: 'Retired', updated_at: nowIso() }).eq('id', assetId)
  loadAssets()
}

document.getElementById('add-asset-form').addEventListener('submit', async (e) => {
  e.preventDefault()

  const type = document.getElementById('new-asset-type').value
  const model = document.getElementById('new-asset-model').value.trim()
  const serial = document.getElementById('new-asset-serial').value.trim()
  const warranty = document.getElementById('new-asset-warranty').value || null
  if (!type) return

  const { error } = await supabase.from('equipment_assets').insert({
    type, model, serial_number: serial, warranty_until: warranty, status: 'Unassigned',
    created_at: nowIso(), updated_at: nowIso(),
  })

  if (error) {
    alert('Could not add asset: ' + error.message)
    return
  }

  e.target.reset()
  loadAssets()
})

// --- Admin: Consumables log ---

async function loadConsumableLog() {
  const { data, error } = await supabase
    .from('equipment_consumable_log')
    .select('*')
    .order('given_at', { ascending: false })
    .limit(200)

  if (error) {
    console.error(error)
    return
  }

  const listEl = document.getElementById('admin-consumables-list')
  listEl.innerHTML = ''

  if (data.length === 0) {
    renderEmptyList(listEl, 'None logged yet.')
    return
  }

  data.forEach((c) => {
    listEl.appendChild(simpleCard([
      `${c.type} × ${c.quantity} — ${profileEmailById.get(c.given_to) || 'Unknown'}`,
      [c.given_at, c.notes].filter(Boolean).join(' · '),
    ]))
  })
}

document.getElementById('add-consumable-form').addEventListener('submit', async (e) => {
  e.preventDefault()

  const type = document.getElementById('new-consumable-type').value
  const givenTo = document.getElementById('new-consumable-employee').value
  const quantity = Number(document.getElementById('new-consumable-qty').value) || 1
  const notes = document.getElementById('new-consumable-notes').value.trim()
  if (!type || !givenTo) return

  const { error } = await supabase.from('equipment_consumable_log').insert({
    type, given_to: givenTo, quantity, notes, given_at: new Date().toISOString().slice(0, 10), created_at: nowIso(),
  })

  if (error) {
    alert('Could not log handout: ' + error.message)
    return
  }

  e.target.reset()
  document.getElementById('new-consumable-qty').value = 1
  loadConsumableLog()
})

// --- Equipment report export (Assets + Consumables + Requests) ---
// Same xlsx-js-style approach as the Tickets report above - a full
// extract, not date-filtered, since "how many of each are unassigned/
// due for renewal right now" is a point-in-time question rather than
// something scoped to a date range.

document.getElementById('export-equipment-report-btn').addEventListener('click', async () => {
  let assets, consumables, requests
  try {
    ;[assets, consumables, requests] = await Promise.all([
      fetchAllRows(() => supabase.from('equipment_assets').select('*').order('type', { ascending: true })),
      fetchAllRows(() => supabase.from('equipment_consumable_log').select('*').order('given_at', { ascending: false })),
      fetchAllRows(() => supabase.from('equipment_requests').select('*').order('created_at', { ascending: false })),
    ])
  } catch (error) {
    alert('Could not build report: ' + error.message)
    return
  }

  const { data: profiles } = await supabase.from('profiles').select('id,email')
  const emailById = new Map((profiles || []).map((p) => [p.id, p.email]))

  const wb = XLSX.utils.book_new()

  // ---- Summary sheet ----
  const dueCount = assets.filter((a) => a.status === 'Assigned' && renewalDue(a.assigned_at, a.type)).length
  const byType = countBy(assets, (a) => a.type)
  const byStatus = countBy(assets, (a) => a.status)

  const summaryRows = [
    ['Equipment Report Summary'],
    [`Generated: ${formatDateTime(nowIso())}`],
    [`Total IT Assets: ${assets.length}`],
    [`Assigned assets due for renewal: ${dueCount}`],
    [`Total consumable handouts logged: ${consumables.length}`],
    [`Total equipment requests: ${requests.length}`],
    [],
    ['Assets by Type'],
    ...byType,
    [],
    ['Assets by Status'],
    ...byStatus,
  ]

  const summarySheet = XLSX.utils.aoa_to_sheet(summaryRows)
  summarySheet['!cols'] = [{ wch: 30 }, { wch: 12 }]
  styleCell(summarySheet, 0, 0, { font: { bold: true, sz: 14 } })
  styleCell(summarySheet, 7, 0, SECTION_FONT)
  styleCell(summarySheet, 8 + byType.length + 1, 0, SECTION_FONT)
  XLSX.utils.book_append_sheet(wb, summarySheet, 'Summary')

  // ---- Assets sheet ----
  const assetHeader = ['Type', 'Model', 'Serial Number', 'Status', 'Assigned To', 'Assigned Date', 'Renewal Due', 'Warranty Until', 'Notes']
  const assetRows = assets.map((a) => [
    a.type, a.model || '', a.serial_number || '', a.status,
    a.assigned_to ? (emailById.get(a.assigned_to) || 'Unknown') : '',
    a.assigned_at || '',
    a.status === 'Assigned' && renewalDue(a.assigned_at, a.type) ? 'Yes' : '',
    a.warranty_until || '',
    a.notes || '',
  ])
  const assetSheet = XLSX.utils.aoa_to_sheet([assetHeader, ...assetRows])
  assetSheet['!cols'] = [{ wch: 14 }, { wch: 22 }, { wch: 18 }, { wch: 12 }, { wch: 24 }, { wch: 14 }, { wch: 12 }, { wch: 14 }, { wch: 30 }]
  assetSheet['!freeze'] = { xSplit: 0, ySplit: 1 }
  assetHeader.forEach((_, col) => styleCell(assetSheet, 0, col, { font: HEADER_FONT, fill: { patternType: 'solid', ...HEADER_FILL } }))
  XLSX.utils.book_append_sheet(wb, assetSheet, 'Assets')

  // ---- Consumables sheet ----
  const consumableHeader = ['Type', 'Given To', 'Quantity', 'Date', 'Notes']
  const consumableRows = consumables.map((c) => [
    c.type, emailById.get(c.given_to) || 'Unknown', c.quantity, c.given_at, c.notes || '',
  ])
  const consumableSheet = XLSX.utils.aoa_to_sheet([consumableHeader, ...consumableRows])
  consumableSheet['!cols'] = [{ wch: 14 }, { wch: 24 }, { wch: 10 }, { wch: 14 }, { wch: 30 }]
  consumableSheet['!freeze'] = { xSplit: 0, ySplit: 1 }
  consumableHeader.forEach((_, col) => styleCell(consumableSheet, 0, col, { font: HEADER_FONT, fill: { patternType: 'solid', ...HEADER_FILL } }))
  XLSX.utils.book_append_sheet(wb, consumableSheet, 'Consumables')

  // ---- Requests sheet ----
  const requestHeader = ['Requested By', 'Type', 'Status', 'Reason', 'Requested', 'Admin Note']
  const requestRows = requests.map((r) => [
    emailById.get(r.requested_by) || 'Unknown', r.type, r.status, r.reason || '', formatDateTime(r.created_at), r.admin_note || '',
  ])
  const requestSheet = XLSX.utils.aoa_to_sheet([requestHeader, ...requestRows])
  requestSheet['!cols'] = [{ wch: 24 }, { wch: 14 }, { wch: 12 }, { wch: 34 }, { wch: 16 }, { wch: 30 }]
  requestSheet['!freeze'] = { xSplit: 0, ySplit: 1 }
  requestHeader.forEach((_, col) => styleCell(requestSheet, 0, col, { font: HEADER_FONT, fill: { patternType: 'solid', ...HEADER_FILL } }))
  XLSX.utils.book_append_sheet(wb, requestSheet, 'Requests')

  XLSX.writeFile(wb, `Equipment_Report_${new Date().toISOString().slice(0, 10)}.xlsx`)
})

// ============================== Employees & Access ================================
// Anything needing Supabase's admin API (create a login, deactivate/
// reactivate, set a password) goes through the "employee-admin" Edge
// Function (supabase/functions/employee-admin/) - see that file's own
// comment for why this can't be done directly from the browser.
// Toggling the "Admin" checkbox on an existing employee is the one
// exception: that's a plain column update the "profiles_admin_update"
// RLS policy already allows directly, no admin API needed for a
// simple boolean flip.

// supabase-js resolves `error` (not `data`) for any non-2xx response
// from an Edge Function, and error.message is a generic "non-2xx
// status" string - the function's own {error: "..."} JSON body is
// only reachable via error.context (the raw Response). This centralizes
// that unwrapping so every call site below gets the real message.
async function invokeEmployeeAdmin(body) {
  const { data, error } = await supabase.functions.invoke('employee-admin', { body })

  if (error) {
    let message = error.message
    try {
      const parsed = await error.context.json()
      if (parsed?.error) message = parsed.error
    } catch (e) { /* fall back to error.message as-is */ }
    return { ok: false, error: message }
  }

  if (data?.error) return { ok: false, error: data.error }
  return { ok: true, data }
}

document.getElementById('add-employee-form').addEventListener('submit', async (e) => {
  e.preventDefault()

  const errorEl = document.getElementById('add-employee-error')
  errorEl.textContent = ''

  const email = document.getElementById('new-employee-email').value.trim()
  const password = document.getElementById('new-employee-password').value
  const isAdmin = document.getElementById('new-employee-admin').checked

  const result = await invokeEmployeeAdmin({ action: 'create', email, password, isAdmin })

  if (!result.ok) {
    errorEl.textContent = result.error
    return
  }

  e.target.reset()
  await loadProfilesMap()
  loadEmployeesTable()
  refreshAllTaxonomyUI() // re-populate every dropdown that lists employees
})

function loadEmployeesTable() {
  const activeBody = document.querySelector('#employees-active-table tbody')
  const inactiveBody = document.querySelector('#employees-inactive-table tbody')
  activeBody.innerHTML = ''
  inactiveBody.innerHTML = ''

  const profiles = [...profilesById.values()].sort((a, b) => a.email.localeCompare(b.email))

  profiles.forEach((p) => {
    if (p.active === false) {
      const tr = document.createElement('tr')

      const emailTd = document.createElement('td')
      emailTd.textContent = p.email
      tr.appendChild(emailTd)

      const actionTd = document.createElement('td')
      const reactivateBtn = document.createElement('button')
      reactivateBtn.type = 'button'
      reactivateBtn.textContent = 'Reactivate'
      reactivateBtn.addEventListener('click', () => setEmployeeActive(p.id, true))
      actionTd.appendChild(reactivateBtn)
      tr.appendChild(actionTd)

      inactiveBody.appendChild(tr)
      return
    }

    const tr = document.createElement('tr')

    const emailTd = document.createElement('td')
    emailTd.textContent = p.email
    tr.appendChild(emailTd)

    const adminTd = document.createElement('td')
    const adminCheckbox = document.createElement('input')
    adminCheckbox.type = 'checkbox'
    adminCheckbox.checked = !!p.is_admin
    adminCheckbox.disabled = p.id === currentUserId // don't let an admin demote themself by accident
    adminCheckbox.addEventListener('change', () => toggleEmployeeAdmin(p.id, adminCheckbox.checked))
    adminTd.appendChild(adminCheckbox)
    tr.appendChild(adminTd)

    const actionsTd = document.createElement('td')
    const controls = document.createElement('div')
    controls.className = 'admin-controls'

    const passwordInput = document.createElement('input')
    passwordInput.type = 'text'
    passwordInput.placeholder = 'New password'
    passwordInput.style.width = '120px'

    const setPasswordBtn = document.createElement('button')
    setPasswordBtn.type = 'button'
    setPasswordBtn.textContent = 'Set Password'
    setPasswordBtn.addEventListener('click', () => setEmployeePassword(p.id, passwordInput))

    const deactivateBtn = document.createElement('button')
    deactivateBtn.type = 'button'
    deactivateBtn.textContent = 'Deactivate'
    deactivateBtn.disabled = p.id === currentUserId // don't let an admin lock themself out
    deactivateBtn.addEventListener('click', () => setEmployeeActive(p.id, false))

    controls.append(passwordInput, setPasswordBtn, deactivateBtn)
    actionsTd.appendChild(controls)
    tr.appendChild(actionsTd)

    activeBody.appendChild(tr)
  })
}

async function toggleEmployeeAdmin(userId, isAdmin) {
  const { error } = await supabase.from('profiles').update({ is_admin: isAdmin }).eq('id', userId)
  if (error) alert('Could not update: ' + error.message)
  await loadProfilesMap()
  loadEmployeesTable()
}

async function setEmployeeActive(userId, active) {
  const result = await invokeEmployeeAdmin({ action: 'setActive', userId, active })
  if (!result.ok) {
    alert('Could not update: ' + result.error)
    return
  }
  await loadProfilesMap()
  loadEmployeesTable()
  refreshAllTaxonomyUI()
}

async function setEmployeePassword(userId, inputEl) {
  const newPassword = inputEl.value
  if (!newPassword || newPassword.length < 6) {
    alert('Enter a password of at least 6 characters.')
    return
  }

  const result = await invokeEmployeeAdmin({ action: 'setPassword', userId, newPassword })
  if (!result.ok) {
    alert('Could not set password: ' + result.error)
    return
  }

  inputEl.value = ''
  alert('Password updated.')
}
