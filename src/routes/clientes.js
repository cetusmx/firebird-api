const express = require('express');
const router = express.Router();
const controller = require('../controllers/clientesController');

// Endpoint: GET /api/clientes/rfc/XAXX010101000
// También soporta: GET /api/clientes/rfc/XAXX010101000?sucursal=3
router.get('/rfc/:rfc', controller.getClienteByRFC);
// Endpoint: GET /api/clientes/ventas
// Soporta filtros: ?almacen=1 & cliente=Juan
router.get('/ventas', controller.obtenerVentas);

module.exports = router;