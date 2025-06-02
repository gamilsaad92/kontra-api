// index.js — Full Kontra API with Virtual Servicing Assistant Integration

const express = require('express');
const cors = require('cors');
const multer = require('multer');
const { createClient } = require('@supabase/supabase-js');
const OpenAI = require('openai');
require('dotenv').config();

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

// Global error handlers
process.on('uncaughtException',    err => console.error('❌ Uncaught Exception:', err));
process.on('unhandledRejection',   err => console.error('❌ Unhandled Rejection:', err));

app.use(cors());
app.use(express.json());

// Supabase client
console.log('Supabase URL:', process.env.SUPABASE_URL);
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// OpenAI client
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Health checks
app.get('/',       (req, res) => res.send('Kontra API is running'));
app.get('/api/test',(req, res) => res.send('✅ API is alive'));

// 📸 Photo validation
app.post('/api/validate-photo', upload.single('image'), (req, res) => {
  if (!req.file) return res.status(400).json({ result: 'No file uploaded' });
  const fileSizeKB = req.file.size / 1024;
  const result = fileSizeKB < 30
    ? 'Image too small — likely blurry ❌'
    : 'Image passed validation ✅';
  res.json({ result });
});

// 🧠 Risk scoring helper
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

// --- AI Agent /api/ask endpoint ---
const functions = [
  {
    name: 'get_loans',
    description: 'Retrieve a list of loans',
    parameters: { type: 'object', properties: {}, required: [] }
  },
  {
    name: 'get_draws',
    description: 'Fetch recent draw requests',
    parameters: { type: 'object', properties: {}, required: [] }
  }
];

async function get_loans() {
  const { data } = await supabase
    .from('loans')
    .select('id, borrower_name, amount, status')
    .order('created_at', { ascending: false });
  return data;
}

async function get_draws() {
  const { data } = await supabase
    .from('draw_requests')
    .select('id, project, amount, status')
    .order('submitted_at', { ascending: false })
    .limit(5);
  return data;
}

app.post('/api/ask', async (req, res) => {
  const { question } = req.body;
  if (!question) return res.status(400).json({ error: 'Missing question' });

  const response = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      { role: 'system', content: 'You are Kontra AI, a loan servicing assistant.' },
      { role: 'user',   content: question }
    ],
    functions,
    function_call: 'auto'
  });

  const msg = response.choices[0].message;

  if (msg.function_call) {
    const result = msg.function_call.name === 'get_loans'
      ? await get_loans()
      : await get_draws();
    return res.json({ assistant: msg, functionResult: result });
  }

  res.json({ assistant: msg });
});

// --- Draw Requests endpoints ---
app.post('/api/draw-request', async (req, res) => {
  const { project, amount, description, project_number, property_location } = req.body;
  if (!project || !amount || !description || !project_number || !property_location) {
    return res.status(400).json({ message: 'Missing required fields' });
  }

  const { data: lastDraw, error: lastDrawError } = await supabase
    .from('draw_requests')
    .select('submitted_at')
    .eq('project', project)
    .order('submitted_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (lastDrawError) return res.status(500).json({ message: 'Error fetching previous draws' });

  const riskScore = calculateRiskScore({ amount, description, lastSubmittedAt: lastDraw?.submitted_at });
  const { data, error } = await supabase
    .from('draw_requests')
    .insert([{ project, amount, description, project_number, property_location, status: 'submitted', risk_score: riskScore, submitted_at: new Date().toISOString() }])
    .select()
    .single();
  if (error) return res.status(500).json({ message: 'Failed to submit draw request' });
  res.json({ message: 'Draw request submitted!', data });
});

app.post('/api/review-draw', async (req, res) => {
  const { id, status, comment } = req.body;
  if (!id || !status) return res.status(400).json({ message: 'Missing id or status' });

  const updates = { status, reviewed_at: new Date().toISOString() };
  if (status === 'approved') updates.approved_at = new Date().toISOString();
  if (status === 'rejected') {
    updates.rejected_at = new Date().toISOString();
    updates.review_comment = comment || '';
  }

  const { data, error } = await supabase
    .from('draw_requests')
    .update(updates)
    .eq('id', id)
    .select()
    .single();
  if (error) return res.status(500).json({ message: 'Failed to update draw request' });
  res.json({ message: 'Draw request updated', data });
});

app.get('/api/get-draws', async (req, res) => {
  const { data, error } = await supabase
    .from('draw_requests')
    .select(`
      id, project, amount, description, project_number, property_location, status,
      submitted_at as submittedAt, reviewed_at as reviewedAt,
      approved_at as approvedAt, rejected_at as rejectedAt,
      review_comment as reviewComment, risk_score as riskScore
    `)
    .order('submitted_at', { ascending: false });
  if (error) return res.status(500).json({ message: 'Failed to fetch draws' });
  res.json({ draws: data });
});

// --- Lien Waivers endpoints ---
app.post('/api/upload-lien-waiver', upload.single('file'), async (req, res) => {
  const { draw_id, contractor_name, waiver_type } = req.body;
  if (!draw_id || !contractor_name || !waiver_type || !req.file) {
    return res.status(400).json({ message: 'Missing required fields or file' });
  }
  const filePath = `lien-waivers/${draw_id}/${Date.now()}_${req.file.originalname}`;
  const { error: uploadError } = await supabase.storage.from('draw-inspections').upload(filePath, req.file.buffer, { contentType: req.file.mimetype });
  if (uploadError) return res.status(500).json({ message: 'File upload failed' });
  const fileUrl = supabase.storage.from('draw-inspections').getPublicUrl(filePath).publicURL;

  const aiReport = { errors: [], fields: {} };
  const passed = aiReport.errors.length === 0;
  const { data, error } = await supabase
    .from('lien_waivers')
    .insert([{ draw_id: parseInt(draw_id,10), contractor_name, waiver_type, file_url: fileUrl, verified_at: new Date().toISOString(), verification_passed: passed, verification_report: aiReport }])
    .select()
    .single();
  if (error) return res.status(500).json({ message: 'Failed to save waiver' });
  res.json({ message: 'Lien waiver uploaded', data });
});

app.get('/api/list-lien-waivers', async (req, res) => {
  const { draw_id } = req.query;
  if (!draw_id) return res.status(400).json({ message: 'Missing draw_id' });

  const { data, error } = await supabase
    .from('lien_waivers')
    .select('id, contractor_name, waiver_type, file_url, verified_at, verification_passed')
    .eq('draw_id', draw_id)
    .order('verified_at', { ascending: false });
  if (error) return res.status(500).json({ message: 'Failed to list waivers' });
  res.json({ waivers: data });
});

// --- Loan servicing endpoints ---
app.post('/api/loans', async (req, res) => {
  const { borrower_name, amount, interest_rate, term_months, start_date } = req.body;
  if (!borrower_name || !amount || !interest_rate || !term_months || !start_date) {
    return res.status(400).json({ message: 'Missing required fields' });
  }
  const { data, error } = await supabase
    .from('loans')
    .insert([{ borrower_name, amount, interest_rate, term_months, start_date }])
    .select()
    .single();
  if (error) return res.status(500).json({ message: 'Failed to create loan' });
  res.status(201).json({ loan: data });
});

app.get('/api/loans', async (req, res) => {
  const { data, error } = await supabase
    .from('loans')
    .select('id, borrower_name, amount, interest_rate, term_months, start_date, status, created_at')
    .order('created_at', { ascending: false });
  if (error) return res.status(500).json({ message: 'Failed to fetch loans' });
  res.json({ loans: data });
});

app.post('/api/loans/:loanId/generate-schedule', async (req, res) => {
  const loanId = parseInt(req.params.loanId, 10);
  const { data: loan, error: loanErr } = await supabase
    .from('loans')
    .select('amount, interest_rate, term_months, start_date')
    .eq('id', loanId)
    .single();
  if (loanErr || !loan) return res.status(404).json({ message: 'Loan not found' });

  const P = parseFloat(loan.amount);
  const r = parseFloat(loan.interest_rate) / 100 / 12;
  const n = parseInt(loan.term_months, 10);
  const A = P * r / (1 - Math.pow(1 + r, -n));

  const inserts = [];
  let balance = P;
  let date = new Date(loan.start_date);
  for (let i = 1; i <= n; i++) {
    const interestDue = balance * r;
    const principalDue = A - interestDue;
    balance -= principalDue;
    inserts.push({ loan_id: loanId, due_date: date.toISOString().slice(0,10), principal_due: principalDue, interest_due: interestDue, balance_after: balance });
    date.setMonth(date.getMonth() + 1);
  }

  const { data: schedule, error: schedErr } = await supabase
    .from('amortization_schedules')
    .insert(inserts)
    .select();
  if (schedErr) return res.status(500).json({ message: 'Failed to generate schedule' });
  res.json({ schedule });
});

app.get('/api/loans/:loanId/schedule', async (req, res) => {
  const loanId = parseInt(req.params.loanId, 10);
  const { data, error } = await supabase
    .from('amortization_schedules')
    .select('*')
    .eq('loan_id', loanId)
    .order('due_date', { ascending: true });
  if (error) return res.status(500).json({ message: 'Failed to fetch schedule' });
  res.json({ schedule: data });
});

app.post('/api/loans/:loanId/payments', async (req, res) => {
  const loanId = parseInt(req.params.loanId, 10);
  const { amount, payment_date } = req.body;
  const { data: lastPayment, error: lastErr } = await supabase
    .from('payments')
    .select('remaining_balance')
    .eq('loan_id', loanId)
    .order('payment_date', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (lastErr) return res.status(500).json({ message: 'Failed to fetch last payment' });
  const prevBalance = lastPayment ? parseFloat(lastPayment.remaining_balance) : null;
  const { data: loanData, error: loanDataErr } = await supabase
    .from('loans')
    .select('amount, interest_rate')
    .eq('id', loanId)
    .single();
  if (loanDataErr) return res.status(404).json({ message: 'Loan not found' });
  const balance = prevBalance !== null ? prevBalance : parseFloat(loanData.amount);
  const r2 = parseFloat(loanData.interest_rate) / 100 / 12;
  const interest = balance * r2;
  const principal = Math.max(0, amount - interest);
  const remaining = balance - principal;
  const { data: payment, error: payErr } = await supabase
    .from('payments')
    .insert([{ loan_id: loanId, payment_date, amount, applied_principal: principal, applied_interest: interest, remaining_balance: remaining }])
    .select()
    .single();
  if (payErr) return res.status(500).json({ message: 'Failed to record payment' });
  res.status(201).json({ payment });
});

// Start server
const PORT = process.env.PORT || 5050;
app.listen(PORT, () => console.log(`Kontra API listening on port ${PORT}`));

// After express.json():
const jwt = require('jsonwebtoken')
const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

// Middleware to check the Authorization header
function checkAuth(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1]
  if (!token) return res.status(401).json({ error: 'No token' })

  // Verify via Supabase JWT secret
  try {
    const { sub: userId } = jwt.verify(token, process.env.SUPABASE_JWT_SECRET)
    req.userId = userId
    return next()
  } catch (err) {
    return res.status(401).json({ error: 'Invalid token' })
  }
}

// Example: protect draw-request route:
app.post('/api/draw-request', checkAuth, async (req, res) => {
  // Now req.userId is available
  const userId = req.userId
  // … insert draw with a created_by: userId field …
})
// Create Project
app.post('/api/projects', checkAuth, async (req, res) => {
  const { name, number, address } = req.body
  const owner_id = req.userId
  if (!name || !number || !address) {
    return res.status(400).json({ message: 'Missing fields' })
  }
  const { data, error } = await supabase
    .from('projects')
    .insert([{ name, number, address, owner_id }])
    .select()
    .single()
  if (error) return res.status(500).json({ message: 'Create failed' })
  res.status(201).json({ project: data })
})

// List Projects (only those you own)
app.get('/api/projects', checkAuth, async (req, res) => {
  const { data, error } = await supabase
    .from('projects')
    .select('*')
    .eq('owner_id', req.userId)
    .order('created_at', { ascending: false })
  if (error) return res.status(500).json({ message: 'Fetch failed' })
  res.json({ projects: data })
})

// Update Project
app.put('/api/projects/:id', checkAuth, async (req, res) => {
  const projectId = parseInt(req.params.id, 10)
  const { name, number, address, status } = req.body
  // Ensure the user owns it
  const { data: existing } = await supabase
    .from('projects')
    .select('owner_id')
    .eq('id', projectId)
    .single()
  if (!existing || existing.owner_id !== req.userId) {
    return res.status(403).json({ message: 'Not allowed' })
  }
  const updates = { name, number, address, status, updated_at: new Date().toISOString() }
  const { data, error } = await supabase
    .from('projects')
    .update(updates)
    .eq('id', projectId)
    .select()
    .single()
  if (error) return res.status(500).json({ message: 'Update failed' })
  res.json({ project: data })
})

// Delete Project (soft-delete or hard-delete)
app.delete('/api/projects/:id', checkAuth, async (req, res) => {
  const projectId = parseInt(req.params.id, 10)
  const { data: existing } = await supabase
    .from('projects')
    .select('owner_id')
    .eq('id', projectId)
    .single()
  if (!existing || existing.owner_id !== req.userId) {
    return res.status(403).json({ message: 'Not allowed' })
  }
  // Here we do a hard delete:
  const { error } = await supabase.from('projects').delete().eq('id', projectId)
  if (error) return res.status(500).json({ message: 'Delete failed' })
  res.json({ message: 'Project removed' })
})
const functions = [
  { name: 'get_loans', … },
  { name: 'get_draws', … },
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
]
async function get_project_status(params) {
  const { projectId } = params
  // 1) Total draws submitted vs approved
  const { data: drawData } = await supabase
    .from('draw_requests')
    .select('id, amount, status')
    .eq('project_id', projectId)

  const totalDraws = drawData.length
  const approvedDraws = drawData.filter(d => d.status === 'approved').length
  const sumDrawn = drawData.filter(d => d.status === 'approved').reduce((acc, d) => acc + parseFloat(d.amount), 0)

  // 2) Outstanding reserve
  // (Assume you have a `reserves` table or calculate via loan minus drawn…)
  const { data: loanData } = await supabase
    .from('loans')
    .select('amount, status')
    .eq('project_id', projectId)
    .single()
  const outstandingReserve = loanData && loanData.status === 'active'
    ? loanData.amount - sumDrawn
    : 0

  return {
    totalDraws,
    approvedDraws,
    sumDrawn,
    outstandingReserve
  }
}

async function get_lien_status(params) {
  const { projectId } = params
  const { data } = await supabase
    .from('lien_waivers')
    .select('id, contractor_name, waiver_type, verification_passed')
    .eq('project_id', projectId)
  return data
}

async function calculate_project_risk(params) {
  const { projectId } = params
  // Fetch draw risk scores
  const { data: draws } = await supabase
    .from('draw_requests')
    .select('risk_score')
    .eq('project_id', projectId)

  // Average risk—simple example:
  const averageRisk = draws.length
    ? draws.reduce((sum, d) => sum + parseFloat(d.risk_score), 0) / draws.length
    : 0

  // Check for overdue inspections (≥7 days since submission)
  const { data: inspections } = await supabase
    .from('inspections')
    .select('id, submitted_at')
    .eq('project_id', projectId)
    .gte('submitted_at', new Date(Date.now() - 7*24*60*60*1000).toISOString())

  const overdueInspections = inspections.length

  return {
    averageRisk,
    overdueInspections
  }
}
if (msg.function_call) {
  const fnName = msg.function_call.name
  let result
  switch(fnName) {
    case 'get_loans':
      result = await get_loans()
      break
    case 'get_draws':
      result = await get_draws()
      break
    case 'get_project_status':
      const { projectId } = JSON.parse(msg.function_call.arguments)
      result = await get_project_status({ projectId })
      break
    case 'get_lien_status':
      const { projectId: pid2 } = JSON.parse(msg.function_call.arguments)
      result = await get_lien_status({ projectId: pid2 })
      break
    case 'calculate_project_risk':
      const { projectId: pid3 } = JSON.parse(msg.function_call.arguments)
      result = await calculate_project_risk({ projectId: pid3 })
      break
    default:
      result = {}
  }
  return res.json({ assistant: msg, functionResult: result })
}
// in index.js
app.get('/api/analytics/draws-volume', checkAuth, async (req, res) => {
  // e.g. counts per month for last 12 months
  const { data, error } = await supabase.rpc('get_draws_volume') // create a Postgres function
  if (error) return res.status(500).json({ message: 'Error' })
  res.json({ drawsVolume: data })
})
const Sentry = require('@sentry/node')
Sentry.init({ dsn: process.env.SENTRY_DSN })
app.use(Sentry.Handlers.requestHandler())
app.use(Sentry.Handlers.errorHandler())
const morgan = require('morgan')
app.use(morgan('combined'))
