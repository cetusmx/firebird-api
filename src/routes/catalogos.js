const express = require('express');
const router = express.Router();
const db = require('../db'); // Conexión a Empresa 2 (sufijo 02)

/**
 * GET /api/almacenes
 * Retorna el catálogo de almacenes activos con formato para DropDownList.
 */
router.get('/almacenes', async (req, res) => {
    try {
        // Usamos alias (as) para mapear CVE_ALM a "id" y DESCR a "nombre"
        const sql = `
            SELECT 
                CVE_ALM as "id", 
                TRIM(DESCR) as "nombre" 
            FROM ALMACENES02 
            WHERE STATUS = 'A' 
            ORDER BY CVE_ALM ASC`;

        const almacenes = await db.query(sql);

        // Al usar alias en el SQL, el arreglo resultante ya viene con el formato deseado
        res.json(almacenes);

    } catch (error) {
        console.error("Error al obtener almacenes:", error.message);
        res.status(500).json({ 
            error: "Error al obtener el catálogo de almacenes", 
            detalle: error.message 
        });
    }
});

module.exports = router;