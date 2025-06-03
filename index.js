// index.js

const express = require('express');
const cors = require('cors');
const multer = require('multer');
const { createClient } = require('@supabase/supabase-js');
const OpenAI = require('openai');          // ← v4+ default export
require('dotenv').config();

const app = express();
const upload = multer({ storage: multer.memoryStorage() });
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ── OpenAI Client (v4+ SDK) ────────────────────────────────────────────────
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Define the functions that the assistant can “call.”
const functions = [
  {
    name: 'get_loans',
    description: 'Retrieve a list of active loans',
    parameters: {
      type: 'object',
      properties: {},
      required: []
    }
  },
  {
    name: 'get_draws',
    description: 'Fetch the five most recent draw requests',
    parameters: {
      type: 'object',
      properties: {},
      required: []
    }
  }
];

// Helper implementations for those functions:
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

// ── Middleware ─────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());

// ── Health Checks ──────────────────────────────────────────────────────────
app.get('/', (req, res) => res.send('Kontra API is running'));
app.get('/api/test', (req, res) => res.send('✅ API is alive'));

// ── AI Photo Validation ────────────────────────────────────────────────────
app.post('/api/validate-photo', upload.single('image'), (req, res) => {
  if (!req.file) return res.status(400).json({ result: 'No file uploaded' });
  const fileSizeKB = req.file.size / 1024;
  const result =
    fileSizeKB < 30
      ? 'Image too small — likely blurry ❌'
      : 'Image passed validation ✅';
  res.json({ result });
});

// ── Risk-Scoring Logic ─────────────────────────────────────────────────────
function calculateRiskScore({ amount, description, lastSubmittedAt }) {
  let score = 100;
  if (amount > 100000) score -= 20;
  if (description.length < 15) score -= 10;
  if (lastSubmittedAt) {
    const lastDate = new Date(lastSubmittedAt);
    const now = new Date();
    const diffInDays = (now - lastDate) / (1000 * 60 * 60 * 24);
    if (diffInDays < 7) score -= 15;
  }
  return Math.max(score, 0);
}

// ── Draw Request Submission ─────────────────────────────────────────────────
app.post('/api/draw-request', async (req, res) => {
  const { project, amount, description, project_number, property_location } = req.body;
  if (!project || !amount || !description || !project_number || !property_location) {
    return res.status(400).json({ message: 'Missing required fields' });
  }

  // 1) Fetch the very last draw for this project to compute risk
  const { data: lastDraw, error: lastDrawError } = await supabase
    .from('draw_requests')
    .select('submitted_at')
    .eq('project', project)
    .order('submitted_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (lastDrawError) {
    console.error('Error fetching last draw:', lastDrawError);
    return res.status(500).json({ message: 'Error fetching previous draws' });
  }

  // 2) Compute risk score
  const riskScore = calculateRiskScore({
    amount,
    description,
    lastSubmittedAt: lastDraw?.submitted_at
  });

  // 3) Insert new draw entry
  const { data, error } = await supabase
    .from('draw_requests')
    .insert([{
      project,
      amount,
      description,
      project_number,
      property_location,
      status: 'submitted',
      risk_score: riskScore,
      submitted_at: new Date().toISOString()
    }])
    .select()
    .single();

  if (error) {
    console.error('Insert error:', error);
    return res.status(500).json({ message: 'Failed to submit draw request' });
  }

  console.log('📥 Submitted draw with risk score:', data.risk_score);
  res.status(200).json({ message: 'Draw request submitted!', data });
});

// ── Review/Approve Draw ─────────────────────────────────────────────────────
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

  if (error) {
    console.error('Update error:', error);
    return res.status(500).json({ message: 'Failed to update draw request' });
  }

  console.log('🔄 Updated draw request:', data);
  res.status(200).json({ message: 'Draw request updated', data });
});

// ── Get All Draws (flatten/alias fields) ────────────────────────────────────
app.get('/api/get-draws', async (req, res) => {
  const { data, error } = await supabase
    .from('draw_requests')
    .select(`
      id,
      project,
      amount,
      description,
      project_number,
      property_location,
      status,
      submitted_at    as submittedAt,
      reviewed_at     as reviewedAt,
      approved_at     as approvedAt,
      rejected_at     as rejectedAt,
      review_comment  as reviewComment,
      risk_score      as riskScore
    `)
    .order('submitted_at', { ascending: false });

  if (error) {
    console.error('Get draws error:', error);
    return res.status(500).json({ message: 'Failed to fetch draw requests' });
  }
  res.json({ draws: data });
});

// ── Upload & Verify Lien Waiver ───────────────────────────────────────────────
app.post('/api/upload-lien-waiver', upload.single('file'), async (req, res) => {
  const { draw_id, contractor_name, waiver_type } = req.body;
  if (!draw_id || !contractor_name || !waiver_type || !req.file) {
    return res.status(400).json({ message: 'Missing required fields or file' });
  }

  // 1) Upload file to Supabase Storage bucket “draw-inspections”
  const filePath = `lien-waivers/${draw_id}/${Date.now()}_${req.file.originalname}`;
  const { error: uploadError } = await supabase
    .storage
    .from('draw-inspections')
    .upload(filePath, req.file.buffer, { contentType: req.file.mimetype });

  if (uploadError) {
    console.error('Storage upload error:', uploadError);
    return res.status(500).json({ message: 'File upload failed' });
  }
  const fileUrl = supabase
    .storage
    .from('draw-inspections')
    .getPublicUrl(filePath)
    .publicURL;

  // 2) Call AI-service stub (could parse PDF, etc.)
  const aiReport = await Promise.resolve({ errors: [], fields: {} }); // replace with real aiService.verifyLienWaiver
  const passed = aiReport.errors.length === 0;

  // 3) Insert record into lien_waivers table
  const { data, error } = await supabase
    .from('lien_waivers')
    .insert([{
      draw_id: parseInt(draw_id, 10),
      contractor_name,
      waiver_type,
      file_url: fileUrl,
      verified_at: new Date().toISOString(),
      verification_passed: passed,
      verification_report: aiReport
    }])
    .select()
    .single();

  if (error) {
    console.error('Insert lien waiver error:', error);
    return res.status(500).json({ message: 'Failed to save waiver' });
  }

  res.status(200).json({ message: 'Lien waiver uploaded', data });
});

// ── List All Lien Waivers for a Given Draw ─────────────────────────────────
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

// ── Create a Loan ───────────────────────────────────────────────────────────
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

// ── List All Loans ──────────────────────────────────────────────────────────
app.get('/api/loans', async (req, res) => {
  const { data, error } = await supabase
    .from('loans')
    .select('id, borrower_name, amount, interest_rate, term_months, start_date, status, created_at')
    .order('created_at', { ascending: false });

  if (error) return res.status(500).json({ message: 'Failed to fetch loans' });
  res.json({ loans: data });
});

// ── Generate Amortization Schedule ──────────────────────────────────────────
app.post('/api/loans/:loanId/generate-schedule', async (req, res) => {
  const { loanId } = req.params;

  // Fetch loan details
  const { data: loan, error: loanErr } = await supabase
    .from('loans')
    .select('amount, interest_rate, term_months, start_date')
    .eq('id', loanId)
    .single();

  if (loanErr || !loan) return res.status(404).json({ message: 'Loan not found' });

  const P = parseFloat(loan.amount);
  const r = parseFloat(loan.interest_rate) / 100 / 12; // monthly rate
  const n = parseInt(loan.term_months, 10);
  const A = P * r / (1 - Math.pow(1 + r, -n)); // standard amortization formula

  const inserts = [];
  let balance = P;
  let date = new Date(loan.start_date);

  for (let i = 1; i <= n; i++) {
    const interestDue = balance * r;
    const principalDue = A - interestDue;
    balance -= principalDue;

    inserts.push({
      loan_id: parseInt(loanId, 10),
      due_date: date.toISOString().slice(0, 10),
      principal_due: principalDue,
      interest_due: interestDue,
      balance_after: balance
    });

    // Advance one month
    date.setMonth(date.getMonth() + 1);
  }

  const { data: scheduleData, error: insertErr } = await supabase
    .from('amortization_schedules')
    .insert(inserts)
    .select();

  if (insertErr) return res.status(500).json({ message: 'Failed to generate schedule' });
  res.json({ schedule: scheduleData });
});

// ── List Amortization Schedule ─────────────────────────────────────────────
app.get('/api/loans/:loanId/schedule', async (req, res) => {
  const { data, error } = await supabase
    .from('amortization_schedules')
    .select('*')
    .eq('loan_id', req.params.loanId)
    .order('due_date', { ascending: true });

  if (error) return res.status(500).json({ message: 'Failed to fetch schedule' });
  res.json({ schedule: data });
});

// ── Record a Payment ───────────────────────────────────────────────────────
app.post('/api/loans/:loanId/payments', async (req, res) => {
  const { amount, payment_date } = req.body;
  const { data: lastPayment, error: lastErr } = await supabase
    .from('payments')
    .select('remaining_balance')
    .eq('loan_id', req.params.loanId)
    .order('payment_date', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (lastErr) return res.status(500).json({ message: 'Failed to fetch last payment' });

  const prevBalance = lastPayment ? parseFloat(lastPayment.remaining_balance) : null;

  // If no previous payment, fetch loan principal
  const { data: loan, error: loanErr } = await supabase
    .from('loans')
    .select('amount')
    .eq('id', req.params.loanId)
    .single();

  if (!loan) return res.status(404).json({ message: 'Loan not found' });

  let balance = prevBalance !== null ? prevBalance : parseFloat(loan.amount);

  // Get the loan’s interest rate for interest calculation
  const { data: loan2 } = await supabase
    .from('loans')
    .select('interest_rate')
    .eq('id', req.params.loanId)
    .single();

  const r = parseFloat(loan2.interest_rate) / 100 / 12;
  const interest = balance * r;
  const principal = Math.max(0, amount - interest);
  const remaining = balance - principal;

  const { data: paymentData, error: paymentErr } = await supabase
    .from('payments')
    .insert([{
      loan_id: parseInt(req.params.loanId, 10),
      payment_date,
      amount,
      applied_principal: principal,
      applied_interest: interest,
      remaining_balance: remaining
    }])
    .select()
    .single();

  if (paymentErr) return res.status(500).json({ message: 'Failed to record payment' });
  res.status(201).json({ payment: paymentData });
});

// ── Virtual-Assistant Endpoint: `/api/ask` ───────────────────────────────────
app.post('/api/ask', async (req, res) => {
  const { question } = req.body;
  if (!question) return res.status(400).json({ error: 'Missing question' });

  try {
    // ← v4+ chat completion call:
    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: 'You are Kontra AI, a loan-servicing and draw-management assistant.' },
        { role: 'user', content: question }
      ],
      functions,
      function_call: 'auto'
    });

    const msg = response.choices[0].message;

    // If OpenAI is instructing a function call, run it
    if (msg.function_call) {
      let result;
      if (msg.function_call.name === 'get_loans') {
        result = await get_loans();
      } else if (msg.function_call.name === 'get_draws') {
        result = await get_draws();
      }
      return res.json({ assistant: msg, functionResult: result });
    }

    // Otherwise, return the assistant’s text
    res.json({ assistant: msg });
  } catch (err) {
    console.error('OpenAI error:', err);
    res.status(500).json({ error: 'AI service failed' });
  }
});

// ── Start Server ──────────────────────────────────────────────────────────
const PORT = process.env.PORT || 5050;
app.listen(PORT, () => {
  console.log(`Kontra API listening on port ${PORT}`);
});
