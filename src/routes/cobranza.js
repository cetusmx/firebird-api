const express = require('express');
const router = express.Router();
const db = require('../db');   // Empresa 2
const db3 = require('../db3'); // Empresa 3 (Fresnillo)

const round2 = (num) => Math.round((num + Number.EPSILON) * 100) / 100;

/**
 * GET /api/dashboard/cxc-resumen
 */
router.get('/cxc-resumen', async (req, res) => {
    const now = new Date();
    const mes = parseInt(req.query.mes) || (now.getMonth() + 1);
    const anio = parseInt(req.query.anio) || now.getFullYear();

    try {
        // --- 1. TOTAL FACTURADO (Real - FACTF) ---
        // Basado en FECHA_DOC
        const sqlFact2 = `
            SELECT SUM(IMPORTE) as TOTAL 
            FROM FACTF02 
            WHERE TIP_DOC = 'F' AND STATUS <> 'C' 
            AND TRIM(CVE_CLPV) <> '4239'
            AND EXTRACT(MONTH FROM FECHA_DOC) = ? 
            AND EXTRACT(YEAR FROM FECHA_DOC) = ?`;

        const sqlFact3 = `
            SELECT SUM(IMPORTE) as TOTAL 
            FROM FACTF03 
            WHERE TIP_DOC = 'F' AND STATUS <> 'C' 
            AND TRIM(CVE_CLPV) <> '2257'
            AND EXTRACT(MONTH FROM FECHA_DOC) = ? 
            AND EXTRACT(YEAR FROM FECHA_DOC) = ?`;

        // --- 2. TOTAL COBRADO (Real - CUEN_DET) ---
        // Basado en FECHA_ELAB, sin filtros de concepto
        const sqlCobrado2 = `
            SELECT SUM(IMPORTE) as TOTAL 
            FROM CUEN_DET02 
            WHERE TRIM(CVE_CLIE) <> '4239'
            AND EXTRACT(MONTH FROM FECHA_ELAB) = ? 
            AND EXTRACT(YEAR FROM FECHA_ELAB) = ?`;

        const sqlCobrado3 = `
            SELECT SUM(IMPORTE) as TOTAL 
            FROM CUEN_DET03 
            WHERE TRIM(CVE_CLIE) <> '2257'
            AND EXTRACT(MONTH FROM FECHA_ELAB) = ? 
            AND EXTRACT(YEAR FROM FECHA_ELAB) = ?`;

        // Ejecución de consultas reales
        const [f2, f3, c2, c3] = await Promise.all([
            db.query(sqlFact2, [mes, anio]),
            db3.query(sqlFact3, [mes, anio]),
            db.query(sqlCobrado2, [mes, anio]),
            db3.query(sqlCobrado3, [mes, anio])
        ]);

        const totalFacturado = round2((f2[0]?.TOTAL || 0) + (f3[0]?.TOTAL || 0));
        const totalCobrado = round2((c2[0]?.TOTAL || 0) + (c3[0]?.TOTAL || 0));
        
        // Cálculo del índice (Cobrado / Facturado * 100)
        const indice = totalFacturado > 0 ? round2((totalCobrado / totalFacturado) * 100) : 0;

        // --- 3. DATOS FICTICIOS TEMPORALES ---
        // Estos se reemplazarán cuando definamos el origen de los saldos
        const antiguedad_ficticia = [
            { "etiqueta": "Al corriente", "monto": 5000000 },
            { "etiqueta": "30-60 días", "monto": 1200000 },
            { "etiqueta": "60-90 días", "monto": 800000 },
            { "etiqueta": "90+ días", "monto": 450000 }
        ];

        const deudores_ficticios = [
            { "nombre": "CLIENTE FICTICIO A", "monto": 850000 },
            { "nombre": "CLIENTE FICTICIO B", "monto": 620000 },
            { "nombre": "CLIENTE FICTICIO C", "monto": 400000 },
            { "nombre": "CLIENTE FICTICIO D", "monto": 310000 },
            { "nombre": "CLIENTE FICTICIO E", "monto": 150000 }
        ];

        // --- RESPUESTA ---
        res.json({
            periodo: { mes, anio },
            cobrabilidad: {
                total_facturado: totalFacturado,
                total_cobrado: totalCobrado,
                indice_cobrabilidad: indice
            },
            antiguedad_saldos: antiguedad_ficticia,
            top_deudores: deudores_ficticios
        });

    } catch (error) {
        console.error("Error en CxC Resumen:", error.message);
        res.status(500).json({ 
            error: "Error al procesar cobranza", 
            detalle: error.message 
        });
    }
});

module.exports = router;