// index.js — Full Kontra API with Virtual Assistant Integration

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
app.get('/',      (req, res) => res.send('Kontra API is running'));
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
    const diffInDays = (new Date() - new Date(lastSubmittedAt)) / (1000*60*60*24);
    if (diffInDays < 7) score -= 15;
  }
  return Math.max(score, 0);
}

// --- AI Agent /ask endpoint ---
// Function definitions for OpenAI function-calling
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

// Helper to fetch loans
async function get_loans() {
  const { data } = await supabase
    .from('loans')
    .select('id, borrower_name, amount, status')
    .order('created_at', { ascending: false });
  return data;
}

// Helper to fetch draws
async function get_draws() {
  const { data } = await supabase
    .from('draw_requests')
    .select('id, project, amount, status')
    .order('submitted_at', { ascending: false })
    .limit(5);
  return data;
}

// Chat endpoint for Virtual Assistant
app.post('/api/ask', async (req, res) => {
  const { question } = req.body;
  if (!question) return res.status(400).json({ error: 'Missing question' });

  // Call OpenAI with function-calling enabled
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

  // If OpenAI wants to call a function, invoke it
  if (msg.function_call) {
    const fnName = msg.function_call.name;
    const result = fnName === 'get_loans'
      ? await get_loans()
      : await get_draws();
    return res.json({ assistant: msg, functionResult: result });
  }

  // Otherwise, simple reply
  res.json({ assistant: msg });
});

// --- Draw Requests ---
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

// Review draw endpoint
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

// Get all draws
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
  if (error) return res.status(500).json({ message: 'Failed to fetch draw requests' });
  res.json({ draws: data });
});

// Upload lien waiver
app.post('/api/upload-lien-waiver', upload.single('file'), async (req, res) => {
  const {
