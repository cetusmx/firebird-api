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
        // --- 1. KPI COBRABILIDAD (Flujo del mes) ---
        const sqlFact2 = `SELECT SUM(IMPORTE) as TOTAL FROM FACTF02 WHERE TIP_DOC='F' AND STATUS<>'C' AND TRIM(CVE_CLPV)<>'4239' AND EXTRACT(MONTH FROM FECHA_DOC)=? AND EXTRACT(YEAR FROM FECHA_DOC)=?`;
        const sqlFact3 = `SELECT SUM(IMPORTE) as TOTAL FROM FACTF03 WHERE TIP_DOC='F' AND STATUS<>'C' AND TRIM(CVE_CLPV)<>'2257' AND EXTRACT(MONTH FROM FECHA_DOC)=? AND EXTRACT(YEAR FROM FECHA_DOC)=?`;
        
        const sqlCobrado2 = `SELECT SUM(IMPORTE) as TOTAL FROM CUEN_DET02 WHERE TRIM(CVE_CLIE)<>'4239' AND EXTRACT(MONTH FROM FECHAELAB)=? AND EXTRACT(YEAR FROM FECHAELAB)=?`;
        const sqlCobrado3 = `SELECT SUM(IMPORTE) as TOTAL FROM CUEN_DET03 WHERE TRIM(CVE_CLIE)<>'2257' AND EXTRACT(MONTH FROM FECHAELAB)=? AND EXTRACT(YEAR FROM FECHAELAB)=?`;

        // --- 2. ANÁLISIS DE CARTERA (Saldos Reales con Nombres de Clientes) ---
        // Integramos CLIE02/CLIE03 para obtener el NOMBRE
        const sqlCartera = (sufijo, clieExcluir) => `
            SELECT 
                F.CVE_CLPV, 
                TRIM(C.NOMBRE) as NOMBRE_CLIENTE,
                F.IMPORTE - COALESCE(P.PAGADO, 0) as SALDO,
                F.FECHA_VEN
            FROM FACTF${sufijo} F
            LEFT JOIN (
                SELECT REFER, SUM(IMPORTE) as PAGADO 
                FROM CUEN_DET${sufijo} 
                GROUP BY REFER
            ) P ON P.REFER = F.CVE_DOC
            INNER JOIN CLIE${sufijo} C ON C.CLAVE = F.CVE_CLPV
            WHERE F.METODODEPAGO = 'PPD' 
            AND F.STATUS <> 'C'
            AND TRIM(F.CVE_CLPV) <> '${clieExcluir}'
            AND (F.IMPORTE - COALESCE(P.PAGADO, 0)) > 0.01`;

        // Ejecutar todas las consultas en paralelo
        const [f2, f3, c2, c3, cartera2, cartera3] = await Promise.all([
            db.query(sqlFact2, [mes, anio]),
            db3.query(sqlFact3, [mes, anio]),
            db.query(sqlCobrado2, [mes, anio]),
            db3.query(sqlCobrado3, [mes, anio]),
            db.query(sqlCartera('02', '4239')),
            db3.query(sqlCartera('03', '2257'))
        ]);

        // Procesar totales de cobrabilidad
        const tFacturado = round2((f2[0]?.TOTAL || 0) + (f3[0]?.TOTAL || 0));
        const tCobrado = round2((c2[0]?.TOTAL || 0) + (c3[0]?.TOTAL || 0));
        const indice = tFacturado > 0 ? round2((tCobrado / tFacturado) * 100) : 0;

        // --- CONSOLIDACIÓN DE CARTERA ---
        const hoy = new Date();
        const antiguedadMap = { "Al corriente": 0, "1-30 días": 0, "31-60 días": 0, "61-90 días": 0, "90+ días": 0 };
        const deudoresMap = {}; // Para sumar facturas por nombre de cliente

        [...cartera2, ...cartera3].forEach(doc => {
            const saldo = parseFloat(doc.SALDO);
            const nombre = doc.NOMBRE_CLIENTE || 'SIN NOMBRE';
            const fVence = new Date(doc.FECHA_VEN);
            
            // 1. Acumular saldo total por cliente (para el Top 10)
            deudoresMap[nombre] = (deudoresMap[nombre] || 0) + saldo;

            // 2. Clasificar por antigüedad (basado en fecha de vencimiento)
            if (fVence >= hoy) {
                antiguedadMap["Al corriente"] += saldo;
            } else {
                const difDias = Math.floor((hoy - fVence) / (1000 * 60 * 60 * 24));
                if (difDias <= 30) antiguedadMap["1-30 días"] += saldo;
                else if (difDias <= 60) antiguedadMap["31-60 días"] += saldo;
                else if (difDias <= 90) antiguedadMap["61-90 días"] += saldo;
                else antiguedadMap["90+ días"] += saldo;
            }
        });

        // Formatear Arreglo de Antigüedad
        const antiguedad_saldos = Object.entries(antiguedadMap).map(([etiqueta, monto]) => ({
            etiqueta, 
            monto: round2(monto)
        }));

        // Formatear Arreglo de Top Deudores (Ordenado por monto de mayor a menor)
        const top_deudores = Object.entries(deudoresMap)
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
            antiguedad_saldos,
            top_deudores
        });

    } catch (error) {
        console.error("Error en CxC Resumen:", error.message);
        res.status(500).json({ error: "Error al procesar cartera", detalle: error.message });
    }
});

module.exports = router;
