// index.js — Fixed Kontra API with Virtual Servicing Assistant Integration

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const jwt = require('jsonwebtoken');
const Sentry = require('@sentry/node');
const morgan = require('morgan');
const { createClient } = require('@supabase/supabase-js');
const OpenAI = require('openai');

//
// ── SENTRY SETUP ───────────────────────────────────────────────────────────────
//
Sentry.init({ dsn: process.env.SENTRY_DSN });

//
// ── EXPRESS APP SETUP ──────────────────────────────────────────────────────────
//
const app = express();
const upload = multer({ storage: multer.memoryStorage() });

// Attach Sentry request handler BEFORE all other middleware
app.use(Sentry.Handlers.requestHandler());
app.use(morgan('combined'));
app.use(cors());
app.use(express.json());

// Global error handlers
process.on('uncaughtException',  err => console.error('❌ Uncaught Exception:', err));
process.on('unhandledRejection', err => console.error('❌ Unhandled Rejection:', err));

//
// ── SUPABASE CLIENTS ───────────────────────────────────────────────────────────
//
const SUPABASE_URL               = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY          = process.env.SUPABASE_ANON_KEY;
const SUPABASE_SERVICE_ROLE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SUPABASE_JWT_SECRET        = process.env.SUPABASE_JWT_SECRET;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SUPABASE_SERVICE_ROLE_KEY || !SUPABASE_JWT_SECRET) {
  console.error('❌ Missing one or more Supabase environment variables.');
  process.exit(1);
}

// Public Supabase client (for server-side usage; using service role key for full privileges)
const supabase      = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
// Admin client alias, if you want a separate client (optional)
const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

//
// ── OPENAI CLIENT ──────────────────────────────────────────────────────────────
//
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
if (!process.env.OPENAI_API_KEY) {
  console.warn('⚠️  OPENAI_API_KEY is not set; /api/ask will fail.');
}

//
// ── AUTH MIDDLEWARE ─────────────────────────────────────────────────────────────
//
function checkAuth(req, res, next) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.split(' ')[1];
  if (!token) {
    return res.status(401).json({ error: 'No token provided' });
  }

  try {
    const payload = jwt.verify(token, SUPABASE_JWT_SECRET);
    req.userId = payload.sub;
    return next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

//
// ── HELPER FUNCTIONS ────────────────────────────────────────────────────────────
//

// Risk scoring helper
function calculateRiskScore({ amount, description, lastSubmittedAt }) {
  let score = 100;
  if (amount > 100000) score -= 20;
  if (description.length < 15) score -= 10;
  if (lastSubmittedAt) {
    const diffInDays = (new Date() - new Date(lastSubmittedAt)) / (1000 * 60 * 60 * 24);
    if (diffInDays < 7) score -= 15;
  }
  return Math.max(score, 0);
}

// AI function: get_loans
async function get_loans() {
  const { data, error } = await supabase
    .from('loans')
    .select('id, borrower_name, amount, status')
    .order('created_at', { ascending: false });

  if (error) {
    console.error('Error in get_loans():', error);
    return [];
  }
  return data;
}

// AI function: get_draws
async function get_draws() {
  const { data, error } = await supabase
    .from('draw_requests')
    .select('id, project, amount, status')
    .order('submitted_at', { ascending: false })
    .limit(5);

  if (error) {
    console.error('Error in get_draws():', error);
    return [];
  }
  return data;
}

// AI function: get_project_status
async function get_project_status(params) {
  const { projectId } = params;
  // 1) Total draws submitted vs approved
  const { data: drawData = [], error: drawErr } = await supabase
    .from('draw_requests')
    .select('id, amount, status')
    .eq('project_id', projectId);

  if (drawErr) {
    console.error('Error fetching draw requests:', drawErr);
    return {};
  }

  const totalDraws    = drawData.length;
  const approvedDraws = drawData.filter(d => d.status === 'approved').length;
  const sumDrawn      = drawData
    .filter(d => d.status === 'approved')
    .reduce((acc, d) => acc + parseFloat(d.amount), 0);

  // 2) Outstanding reserve (assuming loans table has project_id)
  const { data: loanData = null, error: loanErr } = await supabase
    .from('loans')
    .select('amount, status')
    .eq('project_id', projectId)
    .single();

  if (loanErr) {
    console.error('Error fetching loan data:', loanErr);
  }

  const outstandingReserve = loanData && loanData.status === 'active'
    ? loanData.amount - sumDrawn
    : 0;

  return {
    totalDraws,
    approvedDraws,
    sumDrawn,
    outstandingReserve,
  };
}

// AI function: get_lien_status
async function get_lien_status(params) {
  const { projectId } = params;
  const { data = [], error } = await supabase
    .from('lien_waivers')
    .select('id, contractor_name, waiver_type, verification_passed')
    .eq('project_id', projectId);

  if (error) {
    console.error('Error fetching lien waivers:', error);
    return [];
  }
  return data;
}

// AI function: calculate_project_risk
async function calculate_project_risk(params) {
  const { projectId } = params;
  // Fetch draw risk scores
  const { data: draws = [], error: drawErr } = await supabase
    .from('draw_requests')
    .select('risk_score')
    .eq('project_id', projectId);

  if (drawErr) {
    console.error('Error fetching draw risk scores:', drawErr);
  }

  const averageRisk = draws.length
    ? draws.reduce((sum, d) => sum + parseFloat(d.risk_score), 0) / draws.length
    : 0;

  // Check for overdue inspections (≥7 days since submission)
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const { data: inspections = [], error: inspecErr } = await supabase
    .from('inspections')
    .select('id, submitted_at')
    .eq('project_id', projectId)
    .lte('submitted_at', sevenDaysAgo);

  if (inspecErr) {
    console.error('Error fetching inspections:', inspecErr);
  }

  const overdueInspections = inspections.length;

  return {
    averageRisk,
    overdueInspections,
  };
}

//
// ── AI FUNCTIONS LIST ───────────────────────────────────────────────────────────
//
const aiFunctions = [
  {
    name: 'get_loans',
    description: 'Retrieve a list of loans',
    parameters: { type: 'object', properties: {}, required: [] }
  },
  {
    name: 'get_draws',
    description: 'Fetch recent draw requests',
    parameters: { type: 'object', properties: {}, required: [] }
  },
  {
    name: 'get_project_status',
    description: 'Return key metrics for a given project',
    parameters: {
      type: 'object',
      properties: {
        projectId: { type: 'integer', description: 'The project ID' }
      },
      required: ['projectId']
    }
  },
  {
    name: 'get_lien_status',
    description: 'Return list of lien waivers (with pass/fail) for a project',
    parameters: {
      type: 'object',
      properties: {
        projectId: { type: 'integer', description: 'The project ID' }
      },
      required: ['projectId']
    }
  },
  {
    name: 'calculate_project_risk',
    description: 'Aggregate risk scores and return overall project risk',
    parameters: {
      type: 'object',
      properties: {
        projectId: { type: 'integer', description: 'The project ID' }
      },
      required: ['projectId']
    }
  }
];

//
// ── ROUTES ───────────────────────────────────────────────────────────────────────
//

// Health checks
app.get('/',        (req, res) => res.send('Kontra API is running'));
app.get('/api/test', (req, res) => res.send('✅ API is alive'));

//
// ── PHOTO VALIDATION ────────────────────────────────────────────────────────────
//
app.post('/api/validate-photo', upload.single('image'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ result: 'No file uploaded' });
  }
  const fileSizeKB = req.file.size / 1024;
  const result = fileSizeKB < 30
    ? 'Image too small — likely blurry ❌'
    : 'Image passed validation ✅';
  res.json({ result });
});

//
// ── AI AGENT ENDPOINT (/api/ask) ─────────────────────────────────────────────────
//
app.post('/api/ask', async (req, res) => {
  const { question } = req.body;
  if (!question) {
    return res.status(400).json({ error: 'Missing question' });
  }

  if (!process.env.OPENAI_API_KEY) {
    return res.status(500).json({ error: 'OpenAI API key not configured' });
  }

  let response;
  try {
    response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: 'You are Kontra AI, a loan servicing assistant.' },
        { role: 'user',   content: question }
      ],
      functions: aiFunctions,
      function_call: 'auto'
    });
  } catch (err) {
    console.error('OpenAI error:', err);
    return res.status(500).json({ error: 'OpenAI request failed' });
  }

  const msg = response.choices[0].message;
  if (msg.function_call) {
    const fnName = msg.function_call.name;
    const args   = JSON.parse(msg.function_call.arguments || '{}');
    let result;

    try {
      switch (fnName) {
        case 'get_loans':
          result = await get_loans();
          break;
        case 'get_draws':
          result = await get_draws();
          break;
        case 'get_project_status':
          result = await get_project_status({ projectId: args.projectId });
          break;
        case 'get_lien_status':
          result = await get_lien_status({ projectId: args.projectId });
          break;
        case 'calculate_project_risk':
          result = await calculate_project_risk({ projectId: args.projectId });
          break;
        default:
          result = {};
      }
    } catch (fnErr) {
      console.error(`Error executing function ${fnName}:`, fnErr);
      result = {};
    }

    return res.json({ assistant: msg, functionResult: result });
  }

  res.json({ assistant: msg });
});

//
// ── DRAW REQUESTS ────────────────────────────────────────────────────────────────
//
app.post('/api/draw-request', checkAuth, async (req, res) => {
  const { project, amount, description, project_number, property_location } = req.body;
  const userId = req.userId;

  if (!project || !amount || !description || !project_number || !property_location) {
    return res.status(400).json({ message: 'Missing required fields' });
  }

  // Fetch last draw for risk calculation
  const { data: lastDraw, error: lastDrawError } = await supabase
    .from('draw_requests')
    .select('submitted_at')
    .eq('project', project)
    .order('submitted_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (lastDrawError) {
    return res.status(500).json({ message: 'Error fetching previous draws' });
  }

  const riskScore = calculateRiskScore({
    amount,
    description,
    lastSubmittedAt: lastDraw?.submitted_at
  });

  const { data, error } = await supabase
    .from('draw_requests')
    .insert([{
      project,
      amount,
      description,
      project_number,
      property_location,
      created_by: userId,
      status: 'submitted',
      risk_score: riskScore,
      submitted_at: new Date().toISOString()
    }])
    .select()
    .single();

  if (error) {
    return res.status(500).json({ message: 'Failed to submit draw request' });
  }

  res.json({ message: 'Draw request submitted!', data });
});

app.post('/api/review-draw', checkAuth, async (req, res) => {
  const { id, status, comment } = req.body;
  if (!id || !status) {
    return res.status(400).json({ message: 'Missing id or status' });
  }

  const updates = { status, reviewed_at: new Date().toISOString() };
  if (status === 'approved') {
    updates.approved_at = new Date().toISOString();
  } else if (status === 'rejected') {
    updates.rejected_at   = new Date().toISOString();
    updates.review_comment = comment || '';
  }

  const { data, error } = await supabase
    .from('draw_requests')
    .update(updates)
    .eq('id', id)
    .select()
    .single();

  if (error) {
    return res.status(500).json({ message: 'Failed to update draw request' });
  }
  res.json({ message: 'Draw request updated', data });
});

app.get('/api/get-draws', checkAuth, async (req, res) => {
  const { data, error } = await supabase
    .from('draw_requests')
    .select(`
      id, project, amount, description, project_number, property_location, status,
      submitted_at as submittedAt, reviewed_at as reviewedAt,
      approved_at as approvedAt, rejected_at as rejectedAt,
      review_comment as reviewComment, risk_score as riskScore
    `)
    .order('submitted_at', { ascending: false });

  if (error) {
    return res.status(500).json({ message: 'Failed to fetch draws' });
  }
  res.json({ draws: data });
});

//
// ── LIEN WAIVERS ────────────────────────────────────────────────────────────────
//
app.post('/api/upload-lien-waiver', checkAuth, upload.single('file'), async (req, res) => {
  const { draw_id, contractor_name, waiver_type, project_id } = req.body;
  if (!draw_id || !contractor_name || !waiver_type || !project_id || !req.file) {
    return res.status(400).json({ message: 'Missing required fields or file' });
  }

  const filePath = `lien-waivers/${draw_id}/${Date.now()}_${req.file.originalname}`;
  const { error: uploadError } = await supabase
    .storage
    .from('draw-inspections')
    .upload(filePath, req.file.buffer, { contentType: req.file.mimetype });

  if (uploadError) {
    return res.status(500).json({ message: 'File upload failed' });
  }

  const { data: publicUrlData } = supabase
    .storage
    .from('draw-inspections')
    .getPublicUrl(filePath);

  const fileUrl = publicUrlData.publicURL;

  // Placeholder AI report logic (expand as needed)
  const aiReport = { errors: [], fields: {} };
  const passed = aiReport.errors.length === 0;

  const { data, error } = await supabase
    .from('lien_waivers')
    .insert([{
      draw_id:          parseInt(draw_id, 10),
      project_id:       parseInt(project_id, 10),
      contractor_name,
      waiver_type,
      file_url:         fileUrl,
      verified_at:      new Date().toISOString(),
      verification_passed: passed,
      verification_report:  aiReport
    }])
    .select()
    .single();

  if (error) {
    return res.status(500).json({ message: 'Failed to save waiver' });
  }

  res.json({ message: 'Lien waiver uploaded', data });
});

app.get('/api/list-lien-waivers', checkAuth, async (req, res) => {
  const { project_id } = req.query;
  if (!project_id) {
    return res.status(400).json({ message: 'Missing project_id' });
  }

  const { data, error } = await supabase
    .from('lien_waivers')
    .select('id, contractor_name, waiver_type, file_url, verified_at, verification_passed')
    .eq('project_id', project_id)
    .order('verified_at', { ascending: false });

  if (error) {
    return res.status(500).json({ message: 'Failed to list waivers' });
  }

  res.json({ waivers: data });
});

//
// ── LOAN SERVICING ──────────────────────────────────────────────────────────────
//
app.post('/api/loans', checkAuth, async (req, res) => {
  const { borrower_name, amount, interest_rate, term_months, start_date, project_id } = req.body;
  if (!borrower_name || !amount || !interest_rate || !term_months || !start_date || !project_id) {
    return res.status(400).json({ message: 'Missing required fields' });
  }

  const { data, error } = await supabase
    .from('loans')
    .insert([{ 
      borrower_name, 
      amount, 
      interest_rate, 
      term_months, 
      start_date, 
      project_id 
    }])
    .select()
    .single();

  if (error) {
    return res.status(500).json({ message: 'Failed to create loan' });
  }
  res.status(201).json({ loan: data });
});

app.get('/api/loans', checkAuth, async (req, res) => {
  const { data, error } = await supabase
    .from('loans')
    .select('id, borrower_name, amount, interest_rate, term_months, start_date, status, created_at, project_id')
    .order('created_at', { ascending: false });

  if (error) {
    return res.status(500).json({ message: 'Failed to fetch loans' });
  }
  res.json({ loans: data });
});

app.post('/api/loans/:loanId/generate-schedule', checkAuth, async (req, res) => {
  const loanId = parseInt(req.params.loanId, 10);
  const { data: loan, error: loanErr } = await supabase
    .from('loans')
    .select('amount, interest_rate, term_months, start_date')
    .eq('id', loanId)
    .single();

  if (loanErr || !loan) {
    return res.status(404).json({ message: 'Loan not found' });
  }

  const P = parseFloat(loan.amount);
  const r = parseFloat(loan.interest_rate) / 100 / 12;
  const n = parseInt(loan.term_months, 10);
  const A = P * r / (1 - Math.pow(1 + r, -n));

  const inserts = [];
  let balance = P;
  let date = new Date(loan.start_date);

  for (let i = 1; i <= n; i++) {
    const interestDue  = balance * r;
    const principalDue = A - interestDue;
    balance -= principalDue;
    inserts.push({
      loan_id:       loanId,
      due_date:      date.toISOString().slice(0, 10),
      principal_due: principalDue,
      interest_due:  interestDue,
      balance_after: balance
    });
    date.setMonth(date.getMonth() + 1);
  }

  const { data: schedule, error: schedErr } = await supabase
    .from('amortization_schedules')
    .insert(inserts)
    .select();

  if (schedErr) {
    return res.status(500).json({ message: 'Failed to generate schedule' });
  }
  res.json({ schedule });
});

app.get('/api/loans/:loanId/schedule', checkAuth, async (req, res) => {
  const loanId = parseInt(req.params.loanId, 10);
  const { data, error } = await supabase
    .from('amortization_schedules')
    .select('*')
    .eq('loan_id', loanId)
    .order('due_date', { ascending: true });

  if (error) {
    return res.status(500).json({ message: 'Failed to fetch schedule' });
  }
  res.json({ schedule: data });
});

app.post('/api/loans/:loanId/payments', checkAuth, async (req, res) => {
  const loanId = parseInt(req.params.loanId, 10);
  const { amount, payment_date } = req.body;

  const { data: lastPayment, error: lastErr } = await supabase
    .from('payments')
    .select('remaining_balance')
    .eq('loan_id', loanId)
    .order('payment_date', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (lastErr) {
    return res.status(500).json({ message: 'Failed to fetch last payment' });
  }

  const prevBalance = lastPayment ? parseFloat(lastPayment.remaining_balance) : null;
  const { data: loanData, error: loanDataErr } = await supabase
    .from('loans')
    .select('amount, interest_rate')
    .eq('id', loanId)
    .single();
  if (loanDataErr || !loanData) {
    return res.status(404).json({ message: 'Loan not found' });
  }

  const balance = prevBalance !== null ? prevBalance : parseFloat(loanData.amount);
  const r2      = parseFloat(loanData.interest_rate) / 100 / 12;
  const interest  = balance * r2;
  const principal = Math.max(0, amount - interest);
  const remaining = balance - principal;

  const { data: payment, error: payErr } = await supabase
    .from('payments')
    .insert([{
      loan_id:           loanId,
      payment_date,
      amount,
      applied_principal: principal,
      applied_interest:  interest,
      remaining_balance: remaining
    }])
    .select()
    .single();

  if (payErr) {
    return res.status(500).json({ message: 'Failed to record payment' });
  }
  res.status(201).json({ payment });
});

//
// ── PROJECTS ────────────────────────────────────────────────────────────────────
//
app.post('/api/projects', checkAuth, async (req, res) => {
  const { name, number, address } = req.body;
  const owner_id = req.userId;
  if (!name || !number || !address) {
    return res.status(400).json({ message: 'Missing fields' });
  }
  const { data, error } = await supabase
    .from('projects')
    .insert([{ name, number, address, owner_id }])
    .select()
    .single();

  if (error) {
    return res.status(500).json({ message: 'Create failed' });
  }
  res.status(201).json({ project: data });
});

app.get('/api/projects', checkAuth, async (req, res) => {
  const { data, error } = await supabase
    .from('projects')
    .select('*')
    .eq('owner_id', req.userId)
    .order('created_at', { ascending: false });

  if (error) {
    return res.status(500).json({ message: 'Fetch failed' });
  }
  res.json({ projects: data });
});

app.put('/api/projects/:id', checkAuth, async (req, res) => {
  const projectId = parseInt(req.params.id, 10);
  const { name, number, address, status } = req.body;

  const { data: existing, error: existingErr } = await supabase
    .from('projects')
    .select('owner_id')
    .eq('id', projectId)
    .single();
  if (existingErr || !existing) {
    return res.status(404).json({ message: 'Project not found' });
  }
  if (existing.owner_id !== req.userId) {
    return res.status(403).json({ message: 'Not allowed' });
  }

  const updates = { name, number, address, status, updated_at: new Date().toISOString() };
  const { data, error } = await supabase
    .from('projects')
    .update(updates)
    .eq('id', projectId)
    .select()
    .single();

  if (error) {
    return res.status(500).json({ message: 'Update failed' });
  }
  res.json({ project: data });
});

app.delete('/api/projects/:id', checkAuth, async (req, res) => {
  const projectId = parseInt(req.params.id, 10);

  const { data: existing, error: existingErr } = await supabase
    .from('projects')
    .select('owner_id')
    .eq('id', projectId)
    .single();
  if (existingErr || !existing) {
    return res.status(404).json({ message: 'Project not found' });
  }
  if (existing.owner_id !== req.userId) {
    return res.status(403).json({ message: 'Not allowed' });
  }

  const { error } = await supabase
    .from('projects')
    .delete()
    .eq('id', projectId);
  if (error) {
    return res.status(500).json({ message: 'Delete failed' });
  }
  res.json({ message: 'Project removed' });
});

//
// ── ANALYTICS ──────────────────────────────────────────────────────────────────
//
app.get('/api/analytics/draws-volume', checkAuth, async (req, res) => {
  // Assumes you have a Postgres RPC function named `get_draws_volume`
  const { data, error } = await supabase
    .rpc('get_draws_volume');

  if (error) {
    return res.status(500).json({ message: 'Error fetching analytics' });
  }
  res.json({ drawsVolume: data });
});

//
// ── LAST: SENTRY ERROR HANDLER ──────────────────────────────────────────────────
//
app.use(Sentry.Handlers.errorHandler());

//
// ── START SERVER ────────────────────────────────────────────────────────────────
//
const PORT = process.env.PORT || 5050;
app.listen(PORT, () => console.log(`Kontra API listening on port ${PORT}`));
