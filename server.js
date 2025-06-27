const express = require('express');
const bodyParser = require('body-parser');
const path = require('path');
const app = express();
const port = process.env.PORT || 3000;

// Admin IP address (replace with your admin IP)
const adminIP = '127.0.0.1';

// In-memory database
let database = [];

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Middleware to check if the request is from the admin
const isAdmin = (req, res, next) => {
  if (req.ip === adminIP) {
    next();
  } else {
    res.redirect('/user.html');
  }
};

// Admin route to serve the admin panel
app.get('/admin', isAdmin, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// Route to fetch admin data
app.get('/admin/data', isAdmin, (req, res) => {
  res.json(database);
});

// User route to serve the user panel
app.get('/user', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'user.html'));
});

// Submit route to handle user submissions
app.post('/submit', (req, res) => {
  const info = req.body.info;
  database.push(info);
  res.redirect('/user.html');
});

app.listen(port, () => {
  console.log(`Server is running on http://localhost:${port}`);
});
