const express = require('express');
const router = express.Router();
const controller = require('../controllers/comprasController');

// POST /api/compras/reposicion/datos-sae
router.post('/reposicion/datos-sae', controller.getDatosSaeReposicion);

// GET /api/compras/reposicion/ultimas-ventas
router.get('/reposicion/ultimas-ventas', controller.getUltimasVentasReposicion);

module.exports = router;
