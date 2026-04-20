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

const round2 = (num) => Math.round((num + Number.EPSILON) * 100) / 100;

router.get('/ventas-resumen', async (req, res) => {
    const now = new Date();
    const mes = parseInt(req.query.mes) || (now.getMonth() + 1);
    const anio = parseInt(req.query.anio) || now.getFullYear();

    try {
        // --- QUERIES EMPRESA 02 (Principal) ---
        // Usamos TRIM para eliminar espacios y asegurar la exclusión del cliente 4239
        const sqlFacturas2 = `
            SELECT NUM_ALMA, SUM(CAN_TOT) as TOTAL 
            FROM FACTF02 
            WHERE TIP_DOC = 'F' AND STATUS <> 'C' 
            AND TRIM(CVE_CLPV) <> '4239'
            AND EXTRACT(MONTH FROM FECHA_DOC) = ? 
            AND EXTRACT(YEAR FROM FECHA_DOC) = ?
            GROUP BY NUM_ALMA`;

        const sqlRemisiones2 = `
            SELECT NUM_ALMA, SUM(CAN_TOT) as TOTAL 
            FROM FACTR02 
            WHERE TIP_DOC = 'R' AND STATUS <> 'C' 
            AND TRIM(CVE_CLPV) <> '4239'
            AND (COALESCE(TIP_DOC_SIG, '') <> 'F')
            AND EXTRACT(MONTH FROM FECHA_DOC) = ? 
            AND EXTRACT(YEAR FROM FECHA_DOC) = ?
            GROUP BY NUM_ALMA`;

        // --- QUERIES EMPRESA 03 (Fresnillo) ---
        // Usamos TRIM para asegurar la exclusión del cliente 2257
        const sqlFacturas3 = `
            SELECT SUM(CAN_TOT) as TOTAL 
            FROM FACTF03 
            WHERE TIP_DOC = 'F' AND STATUS <> 'C' 
            AND TRIM(CVE_CLPV) <> '2257'
            AND EXTRACT(MONTH FROM FECHA_DOC) = ? 
            AND EXTRACT(YEAR FROM FECHA_DOC) = ?`;

        const sqlRemisiones3 = `
            SELECT SUM(CAN_TOT) as TOTAL 
            FROM FACTR03 
            WHERE TIP_DOC = 'R' AND STATUS <> 'C' 
            AND TRIM(CVE_CLPV) <> '2257'
            AND (COALESCE(TIP_DOC_SIG, '') <> 'F')
            AND EXTRACT(MONTH FROM FECHA_DOC) = ? 
            AND EXTRACT(YEAR FROM FECHA_DOC) = ?`;

        const [f2, r2, f3, r3] = await Promise.all([
            db.query(sqlFacturas2, [mes, anio]),
            db.query(sqlRemisiones2, [mes, anio]),
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

        // Procesar Datos Principal (02)
        f2.forEach(row => {
            if (reporteSucursales[row.NUM_ALMA]) {
                reporteSucursales[row.NUM_ALMA].ventas_facturadas += round2(row.TOTAL);
            }
        });
        r2.forEach(row => {
            if (reporteSucursales[row.NUM_ALMA]) {
                reporteSucursales[row.NUM_ALMA].ventas_remisiones += round2(row.TOTAL);
            }
        });

        // Procesar Fresnillo (03) -> Mapeado a ID 10
        if (f3 && f3[0] && f3[0].TOTAL) {
            reporteSucursales['10'].ventas_facturadas += round2(f3[0].TOTAL);
        }
        if (r3 && r3[0] && r3[0].TOTAL) {
            reporteSucursales['10'].ventas_remisiones += round2(r3[0].TOTAL);
        }

        // Totales Finales
        let globalF = 0;
        let globalR = 0;

        Object.values(reporteSucursales).forEach(suc => {
            suc.ventas_facturadas = round2(suc.ventas_facturadas);
            suc.ventas_remisiones = round2(suc.ventas_remisiones);
            suc.total = round2(suc.ventas_facturadas + suc.ventas_remisiones);
            globalF += suc.ventas_facturadas;
            globalR += suc.ventas_remisiones;
        });

        res.json({
            periodo: { mes, anio },
            resumen_global: {
                facturas: round2(globalF),
                remisiones: round2(globalR),
                total: round2(globalF + globalR)
            },
            detalle_sucursales: Object.values(reporteSucursales)
        });

    } catch (error) {
        console.error("Error en Dashboard (Filtro Clientes):", error.message);
        res.status(500).json({ error: "Error al procesar el dashboard", detalle: error.message });
    }
});

/**
 * GET /api/dashboard/ventas-tendencia
 * Parámetros: ?rango=3|6|12|24 o ?anio=2026
 */
router.get('/ventas-tendencia', async (req, res) => {
    const { rango, anio } = req.query;
    const now = new Date();
    
    let fechaInicio, fechaFin;

    // 1. Determinar el rango de fechas
    if (anio) {
        fechaInicio = `${anio}-01-01`;
        fechaFin = `${anio}-12-31`;
    } else {
        const mesesARetrasar = parseInt(rango) || 3;
        const inicio = new Date(now.getFullYear(), now.getMonth() - (mesesARetrasar - 1), 1);
        fechaInicio = inicio.toISOString().split('T')[0];
        fechaFin = new Date(now.getFullYear(), now.getMonth() + 1, 0).toISOString().split('T')[0];
    }

    try {
        // Query base para Empresa 2 (Principal)
        const sqlBase2 = (tabla) => `
            SELECT 
                EXTRACT(YEAR FROM FECHA_DOC) as ANIO,
                EXTRACT(MONTH FROM FECHA_DOC) as MES,
                NUM_ALMA,
                SUM(CAN_TOT) as TOTAL
            FROM ${tabla}
            WHERE STATUS <> 'C' AND TRIM(CVE_CLPV) <> '4239'
            AND FECHA_DOC BETWEEN '${fechaInicio}' AND '${fechaFin}'
            ${tabla.includes('FACTR') ? "AND (COALESCE(TIP_DOC_SIG, '') <> 'F')" : ""}
            GROUP BY 1, 2, 3
            ORDER BY 1, 2`;

        // Query base para Empresa 3 (Fresnillo)
        const sqlBase3 = (tabla) => `
            SELECT 
                EXTRACT(YEAR FROM FECHA_DOC) as ANIO,
                EXTRACT(MONTH FROM FECHA_DOC) as MES,
                SUM(CAN_TOT) as TOTAL
            FROM ${tabla}
            WHERE STATUS <> 'C' AND TRIM(CVE_CLPV) <> '2257'
            AND FECHA_DOC BETWEEN '${fechaInicio}' AND '${fechaFin}'
            ${tabla.includes('FACTR') ? "AND (COALESCE(TIP_DOC_SIG, '') <> 'F')" : ""}
            GROUP BY 1, 2
            ORDER BY 1, 2`;

        // Ejecución en paralelo
        const [f2, r2, f3, r3] = await Promise.all([
            db.query(sqlBase2('FACTF02')),
            db.query(sqlBase2('FACTR02')),
            db3.query(sqlBase3('FACTF03')),
            db3.query(sqlBase3('FACTR03'))
        ]);

        // 2. Generar el esqueleto de meses para el rango solicitado
        const mesesMap = {};
        const listaMeses = [];
        const nombresMeses = ["Ene", "Feb", "Mar", "Abr", "May", "Jun", "Jul", "Ago", "Sep", "Oct", "Nov", "Dic"];

        let iterador = new Date(fechaInicio + 'T00:00:00');
        const finCorte = new Date(fechaFin + 'T00:00:00');

        while (iterador <= finCorte) {
            const y = iterador.getFullYear();
            const m = iterador.getMonth() + 1;
            const key = `${y}-${String(m).padStart(2, '0')}`;
            
            const objMes = {
                etiqueta: `${nombresMeses[m-1]} ${String(y).slice(-2)}`,
                periodo: key
            };
            
            // Inicializar todas las sucursales en 0
            Object.values(ALMACENES_MAP).forEach(nombre => {
                objMes[nombre] = 0;
            });

            mesesMap[key] = objMes;
            listaMeses.push(key);
            iterador.setMonth(iterador.getMonth() + 1);
        }

        // 3. Poblar datos de Empresa 2
        [...f2, ...r2].forEach(row => {
            const key = `${row.ANIO}-${String(row.MES).padStart(2, '0')}`;
            const nombreSucursal = ALMACENES_MAP[row.NUM_ALMA];
            if (mesesMap[key] && nombreSucursal) {
                mesesMap[key][nombreSucursal] = round2(mesesMap[key][nombreSucursal] + row.TOTAL);
            }
        });

        // 4. Poblar datos de Empresa 3 (Fresnillo)
        [...f3, ...r3].forEach(row => {
            const key = `${row.ANIO}-${String(row.MES).padStart(2, '0')}`;
            if (mesesMap[key]) {
                mesesMap[key]["Fresnillo"] = round2(mesesMap[key]["Fresnillo"] + row.TOTAL);
            }
        });

        // Retornar solo los objetos en orden
        res.json(listaMeses.map(k => mesesMap[k]));

    } catch (error) {
        console.error("Error en Tendencia:", error.message);
        res.status(500).json({ error: "Error al generar tendencia", detalle: error.message });
    }
});

module.exports = router;