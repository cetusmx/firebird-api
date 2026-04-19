const express = require('express');
const router = express.Router();
const db = require('../db');
const db3 = require('../db3');

const ALMACENES_MAP = {
    '1': 'Durango',
    '5': 'Mazatlán',
    '6': 'Zacatecas',
    '7': 'Querétaro',
    '10': 'Fresnillo'
};

// Función auxiliar para redondear a 2 decimales y evitar los .0000000001
const round2 = (num) => Math.round((num + Number.EPSILON) * 100) / 100;

router.get('/ventas-resumen', async (req, res) => {
    const now = new Date();
    const mes = parseInt(req.query.mes) || (now.getMonth() + 1);
    const anio = parseInt(req.query.anio) || now.getFullYear();

    try {
        const sqlFacturas2 = `
            SELECT NUM_ALMA, SUM(CAN_TOT) as TOTAL 
            FROM FACTF02 
            WHERE TIP_DOC = 'F' AND STATUS <> 'C' 
            AND EXTRACT(MONTH FROM FECHA_DOC) = ? 
            AND EXTRACT(YEAR FROM FECHA_DOC) = ?
            GROUP BY NUM_ALMA`;

        // CORRECCIÓN: Usamos COALESCE para que si TIP_DOC_SIG es NULL, no ignore la remisión
        const sqlRemisiones2 = `
            SELECT NUM_ALMA, SUM(CAN_TOT) as TOTAL 
            FROM FACTR02 
            WHERE TIP_DOC = 'R' 
            AND STATUS <> 'C' 
            AND (COALESCE(TIP_DOC_SIG, '') <> 'F')
            AND EXTRACT(MONTH FROM FECHA_DOC) = ? 
            AND EXTRACT(YEAR FROM FECHA_DOC) = ?
            GROUP BY NUM_ALMA`;

        const sqlFacturas3 = `
            SELECT SUM(CAN_TOT) as TOTAL 
            FROM FACTF03 
            WHERE TIP_DOC = 'F' AND STATUS <> 'C' 
            AND EXTRACT(MONTH FROM FECHA_DOC) = ? 
            AND EXTRACT(YEAR FROM FECHA_DOC) = ?`;

        const sqlRemisiones3 = `
            SELECT SUM(CAN_TOT) as TOTAL 
            FROM FACTR03 
            WHERE TIP_DOC = 'R' 
            AND STATUS <> 'C' 
            AND (COALESCE(TIP_DOC_SIG, '') <> 'F')
            AND EXTRACT(MONTH FROM FECHA_DOC) = ? 
            AND EXTRACT(YEAR FROM FECHA_DOC) = ?`;

        const [f2, r2, f3, r3] = await Promise.all([
            db.query(sqlFacturas2, [mes, anio]),
            db.query(r2_sql = sqlRemisiones2, [mes, anio]), // Asignación para debug interno si fuera necesario
            db3.query(sqlFacturas3, [mes, anio]),
            db3.query(sqlRemisiones3, [mes, anio])
        ]);

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

        // Procesar Facturas Principal
        f2.forEach(row => {
            if (reporteSucursales[row.NUM_ALMA]) {
                reporteSucursales[row.NUM_ALMA].ventas_facturadas = round2(row.TOTAL);
            }
        });

        // Procesar Remisiones Principal
        r2.forEach(row => {
            if (reporteSucursales[row.NUM_ALMA]) {
                reporteSucursales[row.NUM_ALMA].ventas_remisiones = round2(row.TOTAL);
            }
        });

        // Procesar Fresnillo (Empresa 3 -> Almacén 10)
        if (f3 && f3[0] && f3[0].TOTAL) {
            reporteSucursales['10'].ventas_facturadas = round2(f3[0].TOTAL);
        }
        if (r3 && r3[0] && r3[0].TOTAL) {
            reporteSucursales['10'].ventas_remisiones = round2(r3[0].TOTAL);
        }

        // Calcular Totales Finales por sucursal y Gran Total
        let globalFacturas = 0;
        let globalRemisiones = 0;

        Object.values(reporteSucursales).forEach(suc => {
            suc.total = round2(suc.ventas_facturadas + suc.ventas_remisiones);
            globalFacturas += suc.ventas_facturadas;
            globalRemisiones += suc.ventas_remisiones;
        });

        res.json({
            periodo: { mes, anio },
            resumen_global: {
                facturas: round2(globalFacturas),
                remisiones: round2(globalRemisiones),
                total: round2(globalFacturas + globalRemisiones)
            },
            detalle_sucursales: Object.values(reporteSucursales)
        });

    } catch (error) {
        console.error("Error en Dashboard:", error.message);
        res.status(500).json({ error: "Error al procesar el dashboard", detalle: error.message });
    }
});

module.exports = router;