const express = require('express');
const router = express.Router();
const controller = require('../controllers/dashboardInventariosController');

// Define el verbo, el endpoint y delega la ejecución al controlador
router.post('/asertividad-ciclico', controller.getAsertividadCiclico);

module.exports = router;