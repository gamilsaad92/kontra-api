const express = require('express');
const cors = require('cors');
const app = express();
require('dotenv').config();

app.use(cors());
app.use(express.json());

app.get('/', (req, res) => {
  res.send('Kontra API is running');
});

app.listen(5000, () => {
  console.log('Kontra API listening on port 5000');
});
