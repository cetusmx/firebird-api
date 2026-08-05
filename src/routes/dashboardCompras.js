const express = require('express');
const router = express.Router();
const controller = require('../controllers/dashboardComprasController');

// GET /api/dashboard-compras/analisis-origen
// Ejemplo: /api/dashboard-compras/analisis-origen?mes=8&anio=2026&familia=SELLOS
router.get('/analisis-origen', controller.getAnalisisOrigenCompras);

module.exports = router;