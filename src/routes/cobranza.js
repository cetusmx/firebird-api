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
        // --- 1. SQL FACTURADO ---
        const sqlFact2 = `SELECT SUM(IMPORTE) as TOTAL FROM FACTF02 WHERE TIP_DOC='F' AND STATUS<>'C' AND TRIM(CVE_CLPV)<>'4239' AND EXTRACT(MONTH FROM FECHA_DOC)=? AND EXTRACT(YEAR FROM FECHA_DOC)=?`;
        const sqlFact3 = `SELECT SUM(IMPORTE) as TOTAL FROM FACTF03 WHERE TIP_DOC='F' AND STATUS<>'C' AND TRIM(CVE_CLPV)<>'2257' AND EXTRACT(MONTH FROM FECHA_DOC)=? AND EXTRACT(YEAR FROM FECHA_DOC)=?`;

        // --- 2. SQL COBRADO (Recibos de caja) ---
        const sqlCobrado2 = `SELECT SUM(IMPORTE) as TOTAL FROM CUEN_DET02 WHERE CVE_CPTO > 1 AND TRIM(CVE_CLIE) <> '4239' AND EXTRACT(MONTH FROM FECHA_ELAB) = ? AND EXTRACT(YEAR FROM FECHA_ELAB) = ?`;
        const sqlCobrado3 = `SELECT SUM(IMPORTE) as TOTAL FROM CUEN_DET03 WHERE CVE_CPTO > 1 AND TRIM(CVE_CLIE) <> '2257' AND EXTRACT(MONTH FROM FECHA_ELAB) = ? AND EXTRACT(YEAR FROM FECHA_ELAB) = ?`;

        // --- 3. SQL ANTIGÜEDAD DE SALDOS (Consolidado) ---
        const sqlAntiguedad = (tabla, clieExcluir) => `
            SELECT 
                CASE 
                    WHEN FECHA_VENC >= CURRENT_DATE THEN 'Al corriente'
                    WHEN DATEDIFF(day, FECHA_VENC, CURRENT_DATE) <= 30 THEN '1-30 días'
                    WHEN DATEDIFF(day, FECHA_VENC, CURRENT_DATE) <= 60 THEN '31-60 días'
                    WHEN DATEDIFF(day, FECHA_VENC, CURRENT_DATE) <= 90 THEN '61-90 días'
                    ELSE '90+ días'
                END as RANGO,
                SUM(SALDO) as TOTAL
            FROM ${tabla} 
            WHERE SALDO > 0.01 AND TRIM(CVE_CLIE) <> '${clieExcluir}'
            GROUP BY 1`;

        // --- 4. SQL TOP DEUDORES ---
        const sqlTop = (tablaM, tablaC, clieExcluir) => `
            SELECT TRIM(C.NOMBRE) as NOMBRE, SUM(M.SALDO) as MONTO
            FROM ${tablaM} M
            JOIN ${tablaC} C ON C.CLAVE = M.CVE_CLIE
            WHERE M.SALDO > 0.01 AND TRIM(M.CVE_CLIE) <> '${clieExcluir}'
            GROUP BY 1`;

        const [f2, f3, c2, c3, ant2, ant3, top2, top3] = await Promise.all([
            db.query(sqlFact2, [mes, anio]),
            db3.query(sqlFact3, [mes, anio]),
            db.query(sqlCobrado2, [mes, anio]),
            db3.query(sqlCobrado3, [mes, anio]),
            db.query(sqlAntiguedad('CUEN_M02', '4239')),
            db3.query(sqlAntiguedad('CUEN_M03', '2257')),
            db.query(sqlTop('CUEN_M02', 'CLIE02', '4239')),
            db3.query(sqlTop('CUEN_M03', 'CLIE03', '2257'))
        ]);

        const tFacturado = round2((f2[0]?.TOTAL || 0) + (f3[0]?.TOTAL || 0));
        const tCobrado = round2((c2[0]?.TOTAL || 0) + (c3[0]?.TOTAL || 0));
        const indice = tFacturado > 0 ? round2((tCobrado / tFacturado) * 100) : 0;

        const rangosOrden = ['Al corriente', '1-30 días', '31-60 días', '61-90 días', '90+ días'];
        const antiguedadMap = {};
        rangosOrden.forEach(r => antiguedadMap[r] = 0);

        [...ant2, ...ant3].forEach(item => {
            const r = item.RANGO.trim();
            if (antiguedadMap[r] !== undefined) antiguedadMap[r] += item.TOTAL;
        });

        const antiguedadFinal = rangosOrden.map(r => ({
            etiqueta: r,
            monto: round2(antiguedadMap[r])
        }));

        const deudoresMap = {};
        [...top2, ...top3].forEach(d => {
            const nombre = d.NOMBRE.trim();
            deudoresMap[nombre] = (deudoresMap[nombre] || 0) + d.MONTO;
        });

        const top10Deudores = Object.entries(deudoresMap)
            .map(([nombre, monto]) => ({ nombre, monto: round2(monto) }))
            .sort((a, b) => b.monto - a.monto)
            .slice(0, 10);

        res.json({
            periodo: { mes, anio },
            cobrabilidad: {
                total_facturado: tFacturado,
                total_cobrado: tCobrado,
                indice_cobrabilidad: indice
            },
            antiguedad_saldos: antiguedadFinal,
            top_deudores: top10Deudores
        });

    } catch (error) {
        console.error("Error en Cobranza:", error.message);
        res.status(500).json({ error: "Error al procesar cobranza", detalle: error.message });
    }
});

module.exports = router;