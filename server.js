const express = require('express');
const bodyParser = require('body-parser');
const app = express();
const port = process.env.PORT || 3000;

// Admin IP address (replace with your admin IP)
const adminIP = '68.102.150.181';

// In-memory database
let database = [];

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Middleware to check if the request is from the admin
const isAdmin = (req, res, next) => {
  if (req.ip === adminIP) {
    next();
  } else {
    res.redirect('/user');
  }
};

// Admin route
app.get('/admin', isAdmin, (req, res) => {
  res.send(`
    <h1>Admin Panel</h1>
    <ul>
      ${database.map((item, index) => `<li>${index + 1}: ${item}</li>`).join('')}
    </ul>
  `);
});

// User route
app.get('/user', (req, res) => {
  res.send(`
    <h1>User Panel</h1>
    <form action="/submit" method="post">
      <label for="info">Enter information:</label><br>
      <textarea id="info" name="info" rows="4" cols="50"></textarea><br>
      <input type="submit" value="Submit">
    </form>
  `);
});

// Submit route to handle user submissions
app.post('/submit', (req, res) => {
  const info = req.body.info;
  database.push(info);
  res.redirect('/user');
});

app.listen(port, () => {
  console.log(`Server is running on http://localhost:${port}`);
});
