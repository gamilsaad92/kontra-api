const express = require('express');
const cors = require('cors');
const app = express();
require('dotenv').config();

app.use(cors());
app.use(express.json());

app.get('/', (req, res) => {
  res.send('Kontra API is running');
});
app.post('/api/draw-request', (req, res) => {
  const { project, amount, description } = req.body;
  console.log("Received draw:", { project, amount, description });
  res.json({ message: `Draw request received for ${project}` });
});

app.listen(5000, () => {
  console.log('Kontra API listening on port 5000');
});
