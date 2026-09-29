// Simulates the observed Express thumbnail sendFile 404 in the disposable
// real-app HTTP test. The original-image static route remains untouched.
const express = require('express');
const original = express.response.sendFile;
express.response.sendFile = function (file, ...args) {
  if (String(file).includes('smallImage')) return this.status(404).end();
  return original.call(this, file, ...args);
};
