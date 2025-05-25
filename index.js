const express = require('express');
const cors = require('cors');
const multer = require('multer');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const app = express();
const upload = multer({ storage: multer.memoryStorage() });
app.use(cors());
app.use(express.json());

// 🔌 Connect to Supabase
typeof process !== 'undefined' && console.log('Supabase URL:', process.env.SUPABASE_URL);
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// 🌐 Health check
app.get('/', (req, res) => res.send('Kontra API is running'));
app.get('/api/test', (req, res) => res.send('✅ API is alive'));

// 📸 AI photo validation
app.post('/api/validate-photo', upload.single('image'), (req, res) => {
  if (!req.file) return res.status(400).json({ result: 'No file uploaded' });
  const fileSizeKB = req.file.size / 1024;
  const result = fileSizeKB < 30
    ? 'Image too small — likely blurry ❌'
    : 'Image passed validation ✅';
  res.json({ result });
});

// 🧠 Risk Scoring Logic
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

// Stub for lien waiver AI verification
async function verifyLienWaiver(fileBuffer) {
  return { errors: [], fields: {} };
}

// 📥 Draw request submission
app.post('/api/draw-request', async (req, res) => {
  const { project, amount, description, project_number, property_location } = req.body;
  if (!project || !amount || !description || !project_number || !property_location) {
    return res.status(400).json({ message: 'Missing required fields' });
  }
  
  // Fetch last draw
  const { data: lastDraw, error: lastErr } = await supabase
    .from('draw_requests')
    .select('submitted_at')
    .eq('project', project)
    .order('submitted_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (lastErr) return res.status(500).json({ message: 'Error fetching previous draws' });

  // Insert new
  const riskScore = calculateRiskScore({ amount, description, lastSubmittedAt: lastDraw?.submitted_at });
  const { data, error } = await supabase
    .from('draw_requests')
    .insert([{ project, amount, description, project_number, property_location, status: 'submitted', risk_score: riskScore, submitted_at: new Date().toISOString() }])
    .select()
    .single();
  if (error) return res.status(500).json({ message: 'Failed to submit draw request' });
  res.json({ message: 'Draw request submitted!', data });
});

// 🔄 Review draw
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

// 🗂️ Get draws
app.get('/api/get-draws', async (req, res) => {
  const { data, error } = await supabase
    .from('draw_requests')
    .select(`
      id, project, amount, description, project_number, property_location, status,
      submitted_at as submittedAt, reviewed_at as reviewedAt, approved_at as approvedAt,
      rejected_at as rejectedAt, review_comment as reviewComment, risk_score as riskScore
    `)
    .order('submitted_at', { ascending: false });
  if (error) return res.status(500).json({ message: 'Failed to fetch draw requests' });
  res.json({ draws: data });
});

// 📁 Lien Waivers upload & list
app.post('/api/upload-lien-waiver', upload.single('file'), async (req, res) => {
  const { draw_id, contractor_name, waiver_type } = req.body;
  if (!draw_id || !contractor_name || !waiver_type || !req.file) {
    return res.status(400).json({ message: 'Missing fields or file' });
  }
  const filePath = `lien-waivers/${draw_id}/${Date.now()}_${req.file.originalname}`;
  const { error: upErr } = await supabase.storage.from('draw-inspections').upload(filePath, req.file.buffer, { contentType: req.file.mimetype });
  if (upErr) return res.status(500).json({ message: 'File upload failed' });
  const fileUrl = supabase.storage.from('draw-inspections').getPublicUrl(filePath).publicURL;
  const aiReport = await verifyLienWaiver(req.file.buffer);
  const passed = aiReport.errors.length === 0;
  const { data, error } = await supabase.from('lien_waivers').insert([{ draw_id: parseInt(draw_id), contractor_name, waiver_type, file_url: fileUrl, verified_at: new Date().toISOString(), verification_passed: passed, verification_report: aiReport }]).select().single();
  if (error) return res.status(500).json({ message: 'Failed to save waiver' });
  res.json({ message: 'Lien waiver uploaded', data });
});
app.get('/api/list-lien-waivers', async (req, res) => {
  const { draw_id } = req.query;
  if (!draw_id) return res.status(400).json({ message: 'Missing draw_id' });
  const { data, error } = await supabase.from('lien_waivers').select('id, contractor_name, waiver_type, file_url, verified_at, verification_passed').eq('draw_id', draw_id).order('verified_at', { ascending: false });
  if (error) return res.status(500).json({ message: 'Failed to list waivers' });
  res.json({ waivers: data });
});

// Loans & amortization
app.post('/api/loans', async (req, res) => {
  const { borrower_name, amount, interest_rate, term_months, start_date } = req.body;
  if (!borrower_name || !amount || !interest_rate || !term_months || !start_date) return res.status(400).json({ message: 'Missing fields' });
  const { data, error } = await supabase.from('loans').insert([{ borrower_name, amount, interest_rate, term_months, start_date }]).select().single();
  if (error) return res.status(500).json({ message: 'Failed to create loan' });
  res.status(201).json({ loan: data });
});
app.get('/api/loans', async (req, res) => {
  const { data, error } = await supabase.from('loans').select('id, borrower_name, amount, interest_rate, term_months, start_date, status, created_at').order('created_at', { ascending: false });
  if (error) return res.status(500).json({ message: 'Failed to fetch loans' });
  res.json({ loans: data });
});
// Amortization
app.post('/api/loans/:loanId/generate-schedule', async (req, res) => {
  const loanId = parseInt(req.params.loanId, 10);
  const { data: loan, error: loanErr } = await supabase.from('loans').select('amount, interest_rate, term_months, start_date').eq('id', loanId).single();
  if (loanErr || !loan) return res.status(404).json({ message: 'Loan not found' });
  const P = parseFloat(loan.amount), r = parseFloat(loan.interest_rate)/100/12, n = parseInt(loan.term_months,10);
  const A = P * r / (1 - Math.pow(1 + r, -n));
  const inserts = []; let balance = P; let date = new Date(loan.start_date);
  for (let i=1; i<=n; i++) {
    const interestDue = balance * r;
    const principalDue = A - interestDue;
    balance -= principalDue;
    inserts.push({ loan_id: loanId, due_date: date.toISOString().slice(0,10), principal_due: principalDue, interest_due: interestDue, balance_after: balance });
    date.setMonth(date.getMonth()+1);
  }
  const { data, error } = await supabase.from('amortization_schedules').insert(inserts).select();
  if (error) return res.status(500).json({ message: 'Failed to generate schedule' });
  res.json({ schedule: data });
});
app.get('/api/loans/:loanId/schedule', async (req, res) => {
  const loanId = parseInt(req.params.loanId,10);
  const { data, error } = await supabase.from('amortization_schedules').select('*').eq('loan_id',loanId).order('due_date',{ascending:true});
  if (error) return res.status(500).json({ message: 'Failed to fetch schedule' });
  res.json({ schedule: data });
});
app.post('/api/loans/:loanId/payments', async (req, res) => {
  const loanId = parseInt(req.params.loanId,10);
  const { amount, payment_date } = req.body;
  const { data: lastPayment, error: lastErr } = await supabase.from('payments').select('remaining_balance').eq('loan_id',loanId).order('payment_date',{ascending:false}).limit(1).maybeSingle();
  if (lastErr) return res.status(500).json({ message: 'Failed to fetch last payment' });
  const prevBal = lastPayment ? parseFloat(lastPayment.remaining_balance) : null;
  const { data: loan, error: loanErr } = await supabase.from('loans').select('amount').eq('id',loanId).single();
  if (loanErr) return res.status(404).json({ message: 'Loan not found' });
  
  let balance = prevBal !== null ? prevBal : parseFloat(loan.amount);
  const { data: loan2 } = await supabase.from('loans').select('interest_rate').eq('id',loanId).single();
  const r = parseFloat(loan2.interest_rate)/100/12;
  const interest = balance * r;
  const principal = Math.max(0, amount - interest);
  const remaining = balance - principal;

  const { data: payment, error: payErr } = await supabase.from('payments').insert([{ loan_id: loanId, payment_date, amount, applied_principal: principal, applied_interest: interest, remaining_balance: remaining }]).select().single();
  if (payErr) return res.status(500).json({ message: 'Failed to record payment' });
  res.status(201).json({ payment });
});
const { Configuration, OpenAIApi } = require('openai');

// 1.1 Initialize OpenAI client
const openai = new OpenAIApi(
  new Configuration({ apiKey: process.env.OPENAI_API_KEY })
);

// 1.2 Define functions for function‑calling
const functions = [
  {
    name: 'get_loans',
    description: 'Retrieve a list of loans',
    parameters: {
      type: 'object',
      properties: {},
      required: []
    }
  },
  {
    name: 'get_draws',
    description: 'Fetch recent draw requests',
    parameters: { type: 'object', properties: {}, required: [] }
  }
];

// 1.3 Helper to fetch data
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

// 1.4 /api/ask route
typedef app.post('/api/ask', async (req, res) => {
  const { question } = req.body;
  if (!question) return res.status(400).json({ error: 'Missing question' });

  // 1.4.1 Call OpenAI with function‑calling enabled
  const response = await openai.createChatCompletion({
    model: 'gpt-4o-mini',
    messages: [
      { role: 'system', content: 'You are Kontra AI, a loan servicing assistant.' },
      { role: 'user', content: question }
    ],
    functions,
    function_call: 'auto'
  });

  const msg = response.data.choices[0].message;

  // 1.4.2 If OpenAI wants to call a function, invoke it
  if (msg.function_call) {
    const fnName = msg.function_call.name;
    const result = await (fnName === 'get_loans' ? get_loans() : get_draws());
    // 1.4.3 Send back function result
    return res.json({ assistant: msg, functionResult: result });
  }

  // 1.4.4 Otherwise, simple reply
  res.json({ assistant: msg });
});
const PORT = process.env.PORT || 5050;
app.listen(PORT, () => console.log(`Kontra API listening on port ${PORT}`));
