const express = require('express');
const router = express.Router();
const db = require('../db');   // Base de datos Principal (Empresa 2)
const db3 = require('../db3'); // Base de datos Fresnillo (Empresa 3)

// Mapeo oficial de tu index.js
const ALMACENES_MAP = {
    '1': 'Durango',
    '5': 'Mazatlán',
    '6': 'Zacatecas',
    '7': 'Querétaro',
    '10': 'Fresnillo'
};

/**
 * GET /api/dashboard/ventas-resumen
 * Filtros opcionales: ?mes=3&anio=2026
 */
router.get('/ventas-resumen', async (req, res) => {
    const now = new Date();
    const mes = parseInt(req.query.mes) || (now.getMonth() + 1);
    const anio = parseInt(req.query.anio) || now.getFullYear();

    try {
        // --- QUERIES PARA EMPRESA 2 (Principal) ---
        const sqlFacturas2 = `
            SELECT NUM_ALMA, SUM(CAN_TOT) as TOTAL 
            FROM FACTF02 
            WHERE TIP_DOC = 'F' AND STATUS <> 'C' 
            AND EXTRACT(MONTH FROM FECHA_DOC) = ? 
            AND EXTRACT(YEAR FROM FECHA_DOC) = ?
            GROUP BY NUM_ALMA`;

        const sqlRemisiones2 = `
            SELECT NUM_ALMA, SUM(CAN_TOT) as TOTAL 
            FROM FACTR02 
            WHERE TIP_DOC = 'R' AND TIP_DOC_SIG <> 'F' AND STATUS <> 'C'
            AND EXTRACT(MONTH FROM FECHA_DOC) = ? 
            AND EXTRACT(YEAR FROM FECHA_DOC) = ?
            GROUP BY NUM_ALMA`;

        // --- QUERIES PARA EMPRESA 3 (Fresnillo) ---
        // Nota: Se usan las tablas terminadas en 03
        const sqlFacturas3 = `
            SELECT SUM(CAN_TOT) as TOTAL 
            FROM FACTF03 
            WHERE TIP_DOC = 'F' AND STATUS <> 'C' 
            AND EXTRACT(MONTH FROM FECHA_DOC) = ? 
            AND EXTRACT(YEAR FROM FECHA_DOC) = ?`;

        const sqlRemisiones3 = `
            SELECT SUM(CAN_TOT) as TOTAL 
            FROM FACTR03 
            WHERE TIP_DOC = 'R' AND TIP_DOC_SIG <> 'F' AND STATUS <> 'C'
            AND EXTRACT(MONTH FROM FECHA_DOC) = ? 
            AND EXTRACT(YEAR FROM FECHA_DOC) = ?`;

        // Ejecución en paralelo siguiendo el patrón de tu search
        const [f2, r2, f3, r3] = await Promise.all([
            db.query(sqlFacturas2, [mes, anio]),
            db.query(sqlRemisiones2, [mes, anio]),
            db3.query(sqlFacturas3, [mes, anio]),
            db3.query(sqlRemisiones3, [mes, anio])
        ]);

        // Estructura de respuesta inicializada con los almacenes conocidos
        const reporteSucursales = {};
        Object.keys(ALMACENES_MAP).forEach(id => {
            reporteSucursales[id] = {
                id: parseInt(id),
                nombre: ALMACENES_MAP[id],
                ventas_facturadas: 0,
                ventas_remisiones: 0,
                total: 0
            };
        });

        // Procesar Facturas Empresa 2
        f2.forEach(row => {
            if (reporteSucursales[row.NUM_ALMA]) {
                reporteSucursales[row.NUM_ALMA].ventas_facturadas += row.TOTAL;
                reporteSucursales[row.NUM_ALMA].total += row.TOTAL;
            }
        });

        // Procesar Remisiones Empresa 2
        r2.forEach(row => {
            if (reporteSucursales[row.NUM_ALMA]) {
                reporteSucursales[row.NUM_ALMA].ventas_remisiones += row.TOTAL;
                reporteSucursales[row.NUM_ALMA].total += row.TOTAL;
            }
        });

        // Procesar Empresa 3 (Fresnillo - ID 10)
        // Como es una base de datos dedicada, sumamos el total directo al almacén 10
        if (f3 && f3[0] && f3[0].TOTAL) {
            reporteSucursales['10'].ventas_facturadas += f3[0].TOTAL;
            reporteSucursales['10'].total += f3[0].TOTAL;
        }
        if (r3 && r3[0] && r3[0].TOTAL) {
            reporteSucursales['10'].ventas_remisiones += r3[0].TOTAL;
            reporteSucursales['10'].total += r3[0].TOTAL;
        }

        // Calcular Gran Total Global para el Pie general
        const totalGlobal = Object.values(reporteSucursales).reduce((acc, suc) => {
            acc.facturas += suc.ventas_facturadas;
            acc.remisiones += suc.ventas_remisiones;
            acc.total += suc.total;
            return acc;
        }, { facturas: 0, remisiones: 0, total: 0 });

        res.json({
            periodo: { mes, anio },
            resumen_global: totalGlobal,
            detalle_sucursales: Object.values(reporteSucursales)
        });

    } catch (error) {
        console.error("Error en Dashboard de Ventas:", error.message);
        res.status(500).json({ error: "Error al procesar el dashboard", detalle: error.message });
    }
});

module.exports = router;