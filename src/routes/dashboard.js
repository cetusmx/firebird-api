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
        // Usamos TRIM para eliminar espacios, excluir cliente 4239 y descontar partidas 'ENVIO'
        const sqlFacturas2 = `
            SELECT F.NUM_ALMA, 
                   SUM(F.CAN_TOT - COALESCE((
                       SELECT SUM(P.TOT_PARTIDA) 
                       FROM PAR_FACTF02 P 
                       WHERE P.CVE_DOC = F.CVE_DOC AND UPPER(TRIM(P.CVE_ART)) = 'ENVIO'
                   ), 0)) as TOTAL 
            FROM FACTF02 F
            WHERE F.TIP_DOC = 'F' AND F.STATUS <> 'C' 
            AND TRIM(F.CVE_CLPV) <> '4239'
            AND EXTRACT(MONTH FROM F.FECHA_DOC) = ? 
            AND EXTRACT(YEAR FROM F.FECHA_DOC) = ?
            GROUP BY F.NUM_ALMA`;

        const sqlRemisiones2 = `
            SELECT R.NUM_ALMA, 
                   SUM(R.CAN_TOT - COALESCE((
                       SELECT SUM(P.TOT_PARTIDA) 
                       FROM PAR_FACTR02 P 
                       WHERE P.CVE_DOC = R.CVE_DOC AND UPPER(TRIM(P.CVE_ART)) = 'ENVIO'
                   ), 0)) as TOTAL 
            FROM FACTR02 R
            WHERE R.TIP_DOC = 'R' AND R.STATUS <> 'C' 
            AND TRIM(R.CVE_CLPV) <> '4239'
            AND (COALESCE(R.TIP_DOC_SIG, '') <> 'F')
            AND EXTRACT(MONTH FROM R.FECHA_DOC) = ? 
            AND EXTRACT(YEAR FROM R.FECHA_DOC) = ?
            GROUP BY R.NUM_ALMA`;

        // --- QUERIES EMPRESA 03 (Fresnillo + Mazatlán + Zacatecas migradas) ---
        // Usamos TRIM para asegurar la exclusión del cliente 2257 y descontar partidas 'ENVIO'
        const sqlFacturas3 = `
            SELECT F.NUM_ALMA, 
                   SUM(F.CAN_TOT - COALESCE((
                       SELECT SUM(P.TOT_PARTIDA) 
                       FROM PAR_FACTF03 P 
                       WHERE P.CVE_DOC = F.CVE_DOC AND UPPER(TRIM(P.CVE_ART)) = 'ENVIO'
                   ), 0)) as TOTAL 
            FROM FACTF03 F
            WHERE F.TIP_DOC = 'F' AND F.STATUS <> 'C' 
            AND TRIM(F.CVE_CLPV) <> '2257'
            AND EXTRACT(MONTH FROM F.FECHA_DOC) = ? 
            AND EXTRACT(YEAR FROM F.FECHA_DOC) = ?
            GROUP BY F.NUM_ALMA`;

        const sqlRemisiones3 = `
            SELECT R.NUM_ALMA, 
                   SUM(R.CAN_TOT - COALESCE((
                       SELECT SUM(P.TOT_PARTIDA) 
                       FROM PAR_FACTR03 P 
                       WHERE P.CVE_DOC = R.CVE_DOC AND UPPER(TRIM(P.CVE_ART)) = 'ENVIO'
                   ), 0)) as TOTAL 
            FROM FACTR03 R
            WHERE R.TIP_DOC = 'R' AND R.STATUS <> 'C' 
            AND TRIM(R.CVE_CLPV) <> '2257'
            AND (COALESCE(R.TIP_DOC_SIG, '') <> 'F')
            AND EXTRACT(MONTH FROM R.FECHA_DOC) = ? 
            AND EXTRACT(YEAR FROM R.FECHA_DOC) = ?
            GROUP BY R.NUM_ALMA`;

        // Ejecución escalonada (primero Empresa 02, luego Empresa 03) para evitar saturar el puerto 3050 de Firebird
        const [f2, r2] = await Promise.all([
            db.query(sqlFacturas2, [mes, anio]),
            db.query(sqlRemisiones2, [mes, anio])
        ]);
        const [f3, r3] = await Promise.all([
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

        // Procesar Datos Fresnillo / Migrados (03)
        // Nota: Fresnillo internamente es el almacén 3, pero se reporta como 10
        f3.forEach(row => {
            const targetId = String(row.NUM_ALMA) === '3' ? '10' : row.NUM_ALMA;
            if (reporteSucursales[targetId]) {
                reporteSucursales[targetId].ventas_facturadas += round2(row.TOTAL);
            }
        });
        r3.forEach(row => {
            const targetId = String(row.NUM_ALMA) === '3' ? '10' : row.NUM_ALMA;
            if (reporteSucursales[targetId]) {
                reporteSucursales[targetId].ventas_remisiones += round2(row.TOTAL);
            }
        });

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
        // Query base para Empresa 2 (Principal) descontando partidas 'ENVIO'
        const sqlBase2 = (tabla) => `
            SELECT 
                EXTRACT(YEAR FROM D.FECHA_DOC) as ANIO,
                EXTRACT(MONTH FROM D.FECHA_DOC) as MES,
                D.NUM_ALMA,
                SUM(D.CAN_TOT - COALESCE((
                    SELECT SUM(P.TOT_PARTIDA) 
                    FROM PAR_${tabla} P 
                    WHERE P.CVE_DOC = D.CVE_DOC AND UPPER(TRIM(P.CVE_ART)) = 'ENVIO'
                ), 0)) as TOTAL
            FROM ${tabla} D
            WHERE D.STATUS <> 'C' AND TRIM(D.CVE_CLPV) <> '4239'
            AND D.FECHA_DOC BETWEEN '${fechaInicio}' AND '${fechaFin}'
            ${tabla.includes('FACTR') ? "AND (COALESCE(D.TIP_DOC_SIG, '') <> 'F')" : ""}
            GROUP BY 1, 2, 3
            ORDER BY 1, 2`;

        // Query base para Empresa 3 (Fresnillo + Mazatlán + Zacatecas migradas) descontando partidas 'ENVIO'
        const sqlBase3 = (tabla) => `
            SELECT 
                EXTRACT(YEAR FROM D.FECHA_DOC) as ANIO,
                EXTRACT(MONTH FROM D.FECHA_DOC) as MES,
                D.NUM_ALMA,
                SUM(D.CAN_TOT - COALESCE((
                    SELECT SUM(P.TOT_PARTIDA) 
                    FROM PAR_${tabla} P 
                    WHERE P.CVE_DOC = D.CVE_DOC AND UPPER(TRIM(P.CVE_ART)) = 'ENVIO'
                ), 0)) as TOTAL
            FROM ${tabla} D
            WHERE D.STATUS <> 'C' AND TRIM(D.CVE_CLPV) <> '2257'
            AND D.FECHA_DOC BETWEEN '${fechaInicio}' AND '${fechaFin}'
            ${tabla.includes('FACTR') ? "AND (COALESCE(D.TIP_DOC_SIG, '') <> 'F')" : ""}
            GROUP BY 1, 2, 3
            ORDER BY 1, 2`;

        // Ejecución escalonada (primero Empresa 02, luego Empresa 03)
        const [f2, r2] = await Promise.all([
            db.query(sqlBase2('FACTF02')),
            db.query(sqlBase2('FACTR02'))
        ]);
        const [f3, r3] = await Promise.all([
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

        // 4. Poblar datos de Empresa 3 (Fresnillo / Migrados)
        [...f3, ...r3].forEach(row => {
            const key = `${row.ANIO}-${String(row.MES).padStart(2, '0')}`;
            const targetId = String(row.NUM_ALMA) === '3' ? '10' : row.NUM_ALMA;
            const nombreSucursal = ALMACENES_MAP[targetId];
            if (mesesMap[key] && nombreSucursal) {
                mesesMap[key][nombreSucursal] = round2(mesesMap[key][nombreSucursal] + row.TOTAL);
            }
        });

        // Retornar solo los objetos en orden
        res.json(listaMeses.map(k => mesesMap[k]));

    } catch (error) {
        console.error("Error en Tendencia:", error.message);
        res.status(500).json({ error: "Error al generar tendencia", detalle: error.message });
    }
});

/**
 * GET /api/dashboard/ventas-detalle
 * Descarga registro por registro todos los documentos contabilizados en /ventas-resumen
 * Parámetros opcionales: ?mes=10&anio=2026&sucursal=5
 */
router.get('/ventas-detalle', async (req, res) => {
    const now = new Date();
    const mes = parseInt(req.query.mes) || (now.getMonth() + 1);
    const anio = parseInt(req.query.anio) || now.getFullYear();
    const filtroSucursal = req.query.sucursal ? String(req.query.sucursal).trim() : null;

    try {
        const buildSqlDetalle = (tablaDoc, tablaPar, tipDoc, clienteExcluido, esRemision) => `
            SELECT
                TRIM(D.CVE_DOC) AS FOLIO,
                D.TIP_DOC,
                D.FECHA_DOC,
                D.STATUS,
                TRIM(D.CVE_CLPV) AS CLIENTE,
                D.NUM_ALMA,
                D.CAN_TOT,
                COALESCE((
                    SELECT SUM(P.TOT_PARTIDA)
                    FROM ${tablaPar} P
                    WHERE P.CVE_DOC = D.CVE_DOC AND UPPER(TRIM(P.CVE_ART)) = 'ENVIO'
                ), 0) AS MONTO_ENVIO,
                D.IMPORTE,
                TRIM(COALESCE(D.TIP_DOC_ANT, '')) AS TIP_DOC_ANT,
                TRIM(COALESCE(D.DOC_ANT, '')) AS DOC_ANT,
                TRIM(COALESCE(D.TIP_DOC_SIG, '')) AS TIP_DOC_SIG,
                TRIM(COALESCE(D.DOC_SIG, '')) AS DOC_SIG
            FROM ${tablaDoc} D
            WHERE D.TIP_DOC = '${tipDoc}' AND D.STATUS <> 'C'
            AND TRIM(D.CVE_CLPV) <> '${clienteExcluido}'
            ${esRemision ? "AND (COALESCE(D.TIP_DOC_SIG, '') <> 'F')" : ""}
            AND EXTRACT(MONTH FROM D.FECHA_DOC) = ?
            AND EXTRACT(YEAR FROM D.FECHA_DOC) = ?
            ORDER BY D.FECHA_DOC ASC, D.CVE_DOC ASC
        `;

        // --- QUERIES EMPRESA 02 (Principal) ---
        const sqlFacturas2 = buildSqlDetalle('FACTF02', 'PAR_FACTF02', 'F', '4239', false);
        const sqlRemisiones2 = buildSqlDetalle('FACTR02', 'PAR_FACTR02', 'R', '4239', true);

        // --- QUERIES EMPRESA 03 (Fresnillo + Mazatlán + Zacatecas migradas) ---
        const sqlFacturas3 = buildSqlDetalle('FACTF03', 'PAR_FACTF03', 'F', '2257', false);
        const sqlRemisiones3 = buildSqlDetalle('FACTR03', 'PAR_FACTR03', 'R', '2257', true);

        // Ejecución escalonada (primero Empresa 02, luego Empresa 03) para evitar saturar el puerto 3050 de Firebird
        const [f2, r2] = await Promise.all([
            db.query(sqlFacturas2, [mes, anio]),
            db.query(sqlRemisiones2, [mes, anio])
        ]);
        const [f3, r3] = await Promise.all([
            db3.query(sqlFacturas3, [mes, anio]),
            db3.query(sqlRemisiones3, [mes, anio])
        ]);

        const registros = [];

        const formatearRegistro = (row, empresa, tablaOrigen, idSucursalMapeado) => {
            const canTot = row.CAN_TOT || 0;
            const montoEnvio = row.MONTO_ENVIO || 0;
            return {
                empresa,
                tabla_origen: tablaOrigen,
                tipo_doc: row.TIP_DOC ? row.TIP_DOC.trim() : '',
                folio: row.FOLIO,
                fecha: row.FECHA_DOC,
                status: row.STATUS ? row.STATUS.trim() : '',
                cliente: row.CLIENTE,
                num_alma: row.NUM_ALMA,
                id_sucursal: parseInt(idSucursalMapeado),
                sucursal: ALMACENES_MAP[idSucursalMapeado],
                subtotal_original_doc: round2(canTot),
                monto_envio_descontado: round2(montoEnvio),
                subtotal_contabilizado: round2(canTot - montoEnvio),
                importe_total: round2(row.IMPORTE || 0),
                tip_doc_ant: row.TIP_DOC_ANT,
                doc_ant: row.DOC_ANT,
                tip_doc_sig: row.TIP_DOC_SIG,
                doc_sig: row.DOC_SIG
            };
        };

        // Procesar Empresa 02
        f2.forEach(row => {
            const idSuc = String(row.NUM_ALMA);
            if (ALMACENES_MAP[idSuc]) {
                registros.push(formatearRegistro(row, 'Empresa 02', 'FACTF02', idSuc));
            }
        });
        r2.forEach(row => {
            const idSuc = String(row.NUM_ALMA);
            if (ALMACENES_MAP[idSuc]) {
                registros.push(formatearRegistro(row, 'Empresa 02', 'FACTR02', idSuc));
            }
        });

        // Procesar Empresa 03
        f3.forEach(row => {
            const idSuc = String(row.NUM_ALMA) === '3' ? '10' : String(row.NUM_ALMA);
            if (ALMACENES_MAP[idSuc]) {
                registros.push(formatearRegistro(row, 'Empresa 03', 'FACTF03', idSuc));
            }
        });
        r3.forEach(row => {
            const idSuc = String(row.NUM_ALMA) === '3' ? '10' : String(row.NUM_ALMA);
            if (ALMACENES_MAP[idSuc]) {
                registros.push(formatearRegistro(row, 'Empresa 03', 'FACTR03', idSuc));
            }
        });

        // Filtrar por sucursal si se envió el parámetro ?sucursal=
        const registrosFiltrados = filtroSucursal
            ? registros.filter(r =>
                String(r.id_sucursal) === (filtroSucursal === '3' ? '10' : filtroSucursal) ||
                r.sucursal.toUpperCase() === filtroSucursal.toUpperCase()
            )
            : registros;

        let sumaFacturas = 0;
        let sumaRemisiones = 0;
        registrosFiltrados.forEach(r => {
            if (r.tipo_doc === 'F') sumaFacturas += r.subtotal_contabilizado;
            if (r.tipo_doc === 'R') sumaRemisiones += r.subtotal_contabilizado;
        });

        res.json({
            periodo: { mes, anio },
            filtro_sucursal: filtroSucursal || 'TODAS',
            total_registros: registrosFiltrados.length,
            resumen_contabilizado: {
                facturas: round2(sumaFacturas),
                remisiones: round2(sumaRemisiones),
                total: round2(sumaFacturas + sumaRemisiones)
            },
            registros: registrosFiltrados
        });

    } catch (error) {
        console.error("Error en Dashboard Ventas Detalle:", error.message);
        res.status(500).json({ error: "Error al obtener el detalle de ventas", detalle: error.message });
    }
});

/**
 * GET /api/dashboard/ventas-detalle-partidas
 * Descarga a nivel partida (PAR_FACTF / PAR_FACTR) el mismo universo de documentos de /ventas-detalle
 * Parámetros opcionales: ?mes=10&anio=2026&sucursal=5
 */
router.get('/ventas-detalle-partidas', async (req, res) => {
    const now = new Date();
    const mes = parseInt(req.query.mes) || (now.getMonth() + 1);
    const anio = parseInt(req.query.anio) || now.getFullYear();
    const filtroSucursal = req.query.sucursal ? String(req.query.sucursal).trim() : null;

    try {
        const buildSqlPartidas = (tablaDoc, tablaPar, tablaInve, tipDoc, clienteExcluido, esRemision) => `
            SELECT
                TRIM(D.CVE_DOC) AS FOLIO,
                D.TIP_DOC,
                D.FECHA_DOC,
                D.STATUS,
                TRIM(D.CVE_CLPV) AS CLIENTE,
                D.NUM_ALMA,
                D.CAN_TOT AS SUBTOTAL_DOC,
                D.IMPORTE AS IMPORTE_DOC,
                TRIM(COALESCE(D.TIP_DOC_ANT, '')) AS TIP_DOC_ANT,
                TRIM(COALESCE(D.DOC_ANT, '')) AS DOC_ANT,
                TRIM(COALESCE(D.TIP_DOC_SIG, '')) AS TIP_DOC_SIG,
                TRIM(COALESCE(D.DOC_SIG, '')) AS DOC_SIG,
                P.NUM_PAR,
                TRIM(P.CVE_ART) AS CVE_ART,
                TRIM(COALESCE(I.DESCR, '')) AS DESCR,
                P.CANT,
                P.PREC,
                COALESCE(P.DESC1, 0) AS DESC1,
                COALESCE(P.DESC2, 0) AS DESC2,
                COALESCE(P.DESC3, 0) AS DESC3,
                P.TOT_PARTIDA,
                COALESCE(P.TOTIMP4, 0) AS TOTIMP4
            FROM ${tablaDoc} D
            INNER JOIN ${tablaPar} P ON D.CVE_DOC = P.CVE_DOC
            LEFT JOIN ${tablaInve} I ON P.CVE_ART = I.CVE_ART
            WHERE D.TIP_DOC = '${tipDoc}' AND D.STATUS <> 'C'
            AND TRIM(D.CVE_CLPV) <> '${clienteExcluido}'
            AND UPPER(TRIM(P.CVE_ART)) <> 'ENVIO'
            ${esRemision ? "AND (COALESCE(D.TIP_DOC_SIG, '') <> 'F')" : ""}
            AND EXTRACT(MONTH FROM D.FECHA_DOC) = ?
            AND EXTRACT(YEAR FROM D.FECHA_DOC) = ?
            ORDER BY D.FECHA_DOC ASC, D.CVE_DOC ASC, P.NUM_PAR ASC
        `;

        // --- QUERIES EMPRESA 02 (Principal) ---
        const sqlFacturas2 = buildSqlPartidas('FACTF02', 'PAR_FACTF02', 'INVE02', 'F', '4239', false);
        const sqlRemisiones2 = buildSqlPartidas('FACTR02', 'PAR_FACTR02', 'INVE02', 'R', '4239', true);

        // --- QUERIES EMPRESA 03 (Fresnillo + Mazatlán + Zacatecas migradas) ---
        const sqlFacturas3 = buildSqlPartidas('FACTF03', 'PAR_FACTF03', 'INVE03', 'F', '2257', false);
        const sqlRemisiones3 = buildSqlPartidas('FACTR03', 'PAR_FACTR03', 'INVE03', 'R', '2257', true);

        // Ejecución escalonada (primero Empresa 02, luego Empresa 03) para evitar saturar el puerto 3050 de Firebird
        const [f2, r2] = await Promise.all([
            db.query(sqlFacturas2, [mes, anio]),
            db.query(sqlRemisiones2, [mes, anio])
        ]);
        const [f3, r3] = await Promise.all([
            db3.query(sqlFacturas3, [mes, anio]),
            db3.query(sqlRemisiones3, [mes, anio])
        ]);

        const partidas = [];

        const formatearPartida = (row, empresa, tablaDoc, tablaPar, idSucursalMapeado) => ({
            empresa,
            tabla_documento: tablaDoc,
            tabla_partida: tablaPar,
            tipo_doc: row.TIP_DOC ? row.TIP_DOC.trim() : '',
            folio: row.FOLIO,
            fecha: row.FECHA_DOC,
            status: row.STATUS ? row.STATUS.trim() : '',
            cliente: row.CLIENTE,
            num_alma: row.NUM_ALMA,
            id_sucursal: parseInt(idSucursalMapeado),
            sucursal: ALMACENES_MAP[idSucursalMapeado],
            subtotal_documento: round2(row.SUBTOTAL_DOC || 0),
            importe_documento: round2(row.IMPORTE_DOC || 0),
            tip_doc_ant: row.TIP_DOC_ANT,
            doc_ant: row.DOC_ANT,
            tip_doc_sig: row.TIP_DOC_SIG,
            doc_sig: row.DOC_SIG,
            num_par: row.NUM_PAR,
            CVE_ART: row.CVE_ART,
            cve_art: row.CVE_ART,
            descripcion: row.DESCR,
            cantidad: row.CANT || 0,
            precio_unitario: round2(row.PREC || 0),
            desc1: row.DESC1 || 0,
            desc2: row.DESC2 || 0,
            desc3: row.DESC3 || 0,
            subtotal_partida: round2(row.TOT_PARTIDA || 0),
            iva_partida: round2(row.TOTIMP4 || 0)
        });

        // Procesar Empresa 02
        f2.forEach(row => {
            const idSuc = String(row.NUM_ALMA);
            if (ALMACENES_MAP[idSuc]) {
                partidas.push(formatearPartida(row, 'Empresa 02', 'FACTF02', 'PAR_FACTF02', idSuc));
            }
        });
        r2.forEach(row => {
            const idSuc = String(row.NUM_ALMA);
            if (ALMACENES_MAP[idSuc]) {
                partidas.push(formatearPartida(row, 'Empresa 02', 'FACTR02', 'PAR_FACTR02', idSuc));
            }
        });

        // Procesar Empresa 03
        f3.forEach(row => {
            const idSuc = String(row.NUM_ALMA) === '3' ? '10' : String(row.NUM_ALMA);
            if (ALMACENES_MAP[idSuc]) {
                partidas.push(formatearPartida(row, 'Empresa 03', 'FACTF03', 'PAR_FACTF03', idSuc));
            }
        });
        r3.forEach(row => {
            const idSuc = String(row.NUM_ALMA) === '3' ? '10' : String(row.NUM_ALMA);
            if (ALMACENES_MAP[idSuc]) {
                partidas.push(formatearPartida(row, 'Empresa 03', 'FACTR03', 'PAR_FACTR03', idSuc));
            }
        });

        // Filtrar por sucursal si se envió el parámetro ?sucursal=
        const partidasFiltradas = filtroSucursal
            ? partidas.filter(p =>
                String(p.id_sucursal) === (filtroSucursal === '3' ? '10' : filtroSucursal) ||
                p.sucursal.toUpperCase() === filtroSucursal.toUpperCase()
            )
            : partidas;

        let sumaPartidasFacturas = 0;
        let sumaPartidasRemisiones = 0;
        partidasFiltradas.forEach(p => {
            if (p.tipo_doc === 'F') sumaPartidasFacturas += p.subtotal_partida;
            if (p.tipo_doc === 'R') sumaPartidasRemisiones += p.subtotal_partida;
        });

        res.json({
            periodo: { mes, anio },
            filtro_sucursal: filtroSucursal || 'TODAS',
            total_partidas: partidasFiltradas.length,
            resumen_partidas: {
                facturas: round2(sumaPartidasFacturas),
                remisiones: round2(sumaPartidasRemisiones),
                total: round2(sumaPartidasFacturas + sumaPartidasRemisiones)
            },
            partidas: partidasFiltradas
        });

    } catch (error) {
        console.error("Error en Dashboard Ventas Detalle Partidas:", error.message);
        res.status(500).json({ error: "Error al obtener el detalle de partidas de ventas", detalle: error.message });
    }
});

// =========================================================================
// CACHÉ EN MEMORIA DEL CATÁLOGO MAESTRO (INVE02 + INVE_CLIB02) - TTL 5 MIN
// =========================================================================
const CATALOGO_TTL_MS = 5 * 60 * 1000;
let catalogoMaestroCache = null;
let catalogoMaestroTimestamp = 0;
let catalogoMaestroPromise = null;

async function obtenerCatalogoMaestroCacheado() {
    const ahora = Date.now();
    if (catalogoMaestroCache && (ahora - catalogoMaestroTimestamp) < CATALOGO_TTL_MS) {
        return catalogoMaestroCache;
    }

    if (catalogoMaestroPromise) {
        return catalogoMaestroPromise;
    }

    const sql = `
        SELECT
            TRIM(I.CVE_ART) AS CVE_ART,
            TRIM(COALESCE(I.DESCR, '')) AS DESCR,
            UPPER(TRIM(COALESCE(C.CAMPLIB21, ''))) AS GENERO,
            UPPER(TRIM(COALESCE(C.CAMPLIB24, ''))) AS FAMILIA,
            UPPER(TRIM(COALESCE(I.LIN_PROD, ''))) AS LINEA
        FROM INVE02 I
        LEFT JOIN INVE_CLIB02 C ON I.CVE_ART = C.CVE_PROD
        WHERE I.STATUS = 'A'
    `;

    catalogoMaestroPromise = db.query(sql)
        .then(rows => {
            catalogoMaestroCache = rows;
            catalogoMaestroTimestamp = Date.now();
            catalogoMaestroPromise = null;
            return rows;
        })
        .catch(err => {
            catalogoMaestroPromise = null;
            throw err;
        });

    return catalogoMaestroPromise;
}

/**
 * GET /api/dashboard/filtros-catalogo
 * Filtrado cruzado reactivo (auto-excluyente) para Género (CAMPLIB21), Familia (CAMPLIB24) y Línea (LIN_PROD).
 * Parámetros opcionales: ?genero=...&familia=...&linea=...
 */
router.get('/filtros-catalogo', async (req, res) => {
    const { genero, familia, linea } = req.query;

    const targetGenero = genero && String(genero).trim().toUpperCase() !== 'TODOS'
        ? String(genero).trim().toUpperCase()
        : null;
    const targetFamilia = familia && String(familia).trim().toUpperCase() !== 'TODOS'
        ? String(familia).trim().toUpperCase()
        : null;
    const targetLinea = linea && String(linea).trim().toUpperCase() !== 'TODOS'
        ? String(linea).trim().toUpperCase()
        : null;

    try {
        const rows = await obtenerCatalogoMaestroCacheado();

        const cumple = (valRow, valTarget) => {
            if (!valTarget) return true;
            if (!valRow) return false;
            return valRow === valTarget;
        };

        const setGeneros = new Set();
        const setFamilias = new Set();
        const setLineas = new Set();

        rows.forEach(row => {
            const gen = row.GENERO || null;
            const fam = row.FAMILIA || null;
            const lin = row.LINEA || null;

            const matchGen = cumple(gen, targetGenero);
            const matchFam = cumple(fam, targetFamilia);
            const matchLin = cumple(lin, targetLinea);

            // Filtrado cruzado auto-excluyente: cada lista ignora su propio filtro para permitir cambiar de opción,
            // pero se acota inmediatamente por los otros dos filtros activos.
            if (matchFam && matchLin && gen) setGeneros.add(gen);
            if (matchGen && matchLin && fam) setFamilias.add(fam);
            if (matchGen && matchFam && lin) setLineas.add(lin);
        });

        const ordenarAlfa = (a, b) => a.localeCompare(b);

        res.json({
            opciones_genero: Array.from(setGeneros).sort(ordenarAlfa),
            opciones_familia: Array.from(setFamilias).sort(ordenarAlfa),
            opciones_linea: Array.from(setLineas).sort(ordenarAlfa)
        });

    } catch (error) {
        console.error("Error en /api/dashboard/filtros-catalogo:", error.message);
        res.status(500).json({
            error: "Error al obtener el catálogo de filtros",
            detalle: error.message
        });
    }
});

/**
 * GET /api/dashboard/ventas-partidas-mensual
 * Serie mensual unificada para las gráficas de Ventas (subtotal) y Partidas (cantidad de partidas).
 * Parámetros opcionales: ?almacen=&tipo_venta=&genero=&familia=&linea=&mes=&anio=
 */
router.get('/ventas-partidas-mensual', async (req, res) => {
    const now = new Date();
    const anio = parseInt(req.query.anio) || now.getFullYear();

    const rawMes = req.query.mes;
    const mesFiltro = (rawMes && String(rawMes).toUpperCase() !== 'TODOS' && parseInt(rawMes) >= 1 && parseInt(rawMes) <= 12)
        ? parseInt(rawMes)
        : null;

    const rawAlmacen = req.query.almacen || req.query.sucursal;
    const filtroAlmacen = (rawAlmacen && String(rawAlmacen).toUpperCase() !== 'TODOS' && String(rawAlmacen).trim() !== '')
        ? String(rawAlmacen).trim()
        : null;

    const rawTipoVenta = req.query.tipo_venta || req.query.tipo_cliente;
    const tipoVenta = (rawTipoVenta && String(rawTipoVenta).toUpperCase() !== 'TODOS' && String(rawTipoVenta).trim() !== '')
        ? String(rawTipoVenta).trim().toUpperCase()
        : null;

    const genero = (req.query.genero && String(req.query.genero).toUpperCase() !== 'TODOS' && String(req.query.genero).trim() !== '')
        ? String(req.query.genero).trim().toUpperCase()
        : null;

    const familia = (req.query.familia && String(req.query.familia).toUpperCase() !== 'TODOS' && String(req.query.familia).trim() !== '')
        ? String(req.query.familia).trim().toUpperCase()
        : null;

    const linea = (req.query.linea && String(req.query.linea).toUpperCase() !== 'TODOS' && String(req.query.linea).trim() !== '')
        ? String(req.query.linea).trim().toUpperCase()
        : null;

    const hayFiltroProducto = Boolean(genero || familia || linea);

    // Determinar si el almacén seleccionado es exclusivo de Empresa 02 (Durango = 1, Querétaro = 7)
    const almUpper = filtroAlmacen ? filtroAlmacen.toUpperCase() : '';
    const esSoloEmpresa02 = almUpper === '1' || almUpper === '7' || almUpper === 'DURANGO' || almUpper === 'QUERÉTARO' || almUpper === 'QUERETARO';

    try {
        const buildQueryEmp2 = (tipoDoc, clienteExcluido) => {
            const tablaDoc = tipoDoc === 'F' ? 'FACTF02' : 'FACTR02';
            const tablaPar = tipoDoc === 'F' ? 'PAR_FACTF02' : 'PAR_FACTR02';

            const where = [
                `D.TIP_DOC = '${tipoDoc}'`,
                `D.STATUS <> 'C'`,
                `TRIM(D.CVE_CLPV) <> '${clienteExcluido}'`,
                `UPPER(TRIM(P.CVE_ART)) <> 'ENVIO'`,
                `EXTRACT(YEAR FROM D.FECHA_DOC) = ?`
            ];
            const params = [anio];

            if (tipoDoc === 'R') {
                where.push(`(COALESCE(D.TIP_DOC_SIG, '') <> 'F')`);
            }

            if (mesFiltro) {
                where.push(`EXTRACT(MONTH FROM D.FECHA_DOC) = ?`);
                params.push(mesFiltro);
            }

            if (tipoVenta === 'CREDITO' || tipoVenta === 'CRÉDITO' || tipoVenta === 'S') {
                where.push(`UPPER(TRIM(COALESCE(CL.CON_CREDITO, 'N'))) = 'S'`);
            } else if (tipoVenta === 'CONTADO' || tipoVenta === 'N') {
                where.push(`UPPER(TRIM(COALESCE(CL.CON_CREDITO, 'N'))) = 'N'`);
            }

            if (genero) {
                where.push(`UPPER(TRIM(COALESCE(L.CAMPLIB21, ''))) = ?`);
                params.push(genero);
            }

            if (familia) {
                where.push(`UPPER(TRIM(COALESCE(L.CAMPLIB24, ''))) = ?`);
                params.push(familia);
            }

            if (linea) {
                where.push(`UPPER(TRIM(COALESCE(I.LIN_PROD, ''))) = ?`);
                params.push(linea);
            }

            const sql = `
                SELECT
                    EXTRACT(MONTH FROM D.FECHA_DOC) AS MES,
                    D.NUM_ALMA,
                    SUM(P.TOT_PARTIDA) AS SUBTOTAL,
                    COUNT(*) AS PARTIDAS
                FROM ${tablaDoc} D
                INNER JOIN ${tablaPar} P ON D.CVE_DOC = P.CVE_DOC
                LEFT JOIN CLIE02 CL ON D.CVE_CLPV = CL.CLAVE
                LEFT JOIN INVE02 I ON P.CVE_ART = I.CVE_ART
                LEFT JOIN INVE_CLIB02 L ON P.CVE_ART = L.CVE_PROD
                WHERE ${where.join(' AND ')}
                GROUP BY 1, 2
                ORDER BY 1
            `;

            return { sql, params };
        };

        const buildQueryEmp3 = (tipoDoc, clienteExcluido) => {
            const tablaDoc = tipoDoc === 'F' ? 'FACTF03' : 'FACTR03';
            const tablaPar = tipoDoc === 'F' ? 'PAR_FACTF03' : 'PAR_FACTR03';

            const where = [
                `D.TIP_DOC = '${tipoDoc}'`,
                `D.STATUS <> 'C'`,
                `TRIM(D.CVE_CLPV) <> '${clienteExcluido}'`,
                `UPPER(TRIM(P.CVE_ART)) <> 'ENVIO'`,
                `EXTRACT(YEAR FROM D.FECHA_DOC) = ?`
            ];
            const params = [anio];

            if (tipoDoc === 'R') {
                where.push(`(COALESCE(D.TIP_DOC_SIG, '') <> 'F')`);
            }

            if (mesFiltro) {
                where.push(`EXTRACT(MONTH FROM D.FECHA_DOC) = ?`);
                params.push(mesFiltro);
            }

            if (tipoVenta === 'CREDITO' || tipoVenta === 'CRÉDITO' || tipoVenta === 'S') {
                where.push(`UPPER(TRIM(COALESCE(CL.CON_CREDITO, 'N'))) = 'S'`);
            } else if (tipoVenta === 'CONTADO' || tipoVenta === 'N') {
                where.push(`UPPER(TRIM(COALESCE(CL.CON_CREDITO, 'N'))) = 'N'`);
            }

            // Si hay filtro de producto, agrupamos también por CVE_ART para cruzar contra el Catálogo Maestro cacheado
            const selectArt = hayFiltroProducto ? `, TRIM(P.CVE_ART) AS CVE_ART` : '';
            const groupBy = hayFiltroProducto ? `GROUP BY 1, 2, 3` : `GROUP BY 1, 2`;

            const sql = `
                SELECT
                    EXTRACT(MONTH FROM D.FECHA_DOC) AS MES,
                    D.NUM_ALMA${selectArt},
                    SUM(P.TOT_PARTIDA) AS SUBTOTAL,
                    COUNT(*) AS PARTIDAS
                FROM ${tablaDoc} D
                INNER JOIN ${tablaPar} P ON D.CVE_DOC = P.CVE_DOC
                LEFT JOIN CLIE03 CL ON D.CVE_CLPV = CL.CLAVE
                WHERE ${where.join(' AND ')}
                ${groupBy}
                ORDER BY 1
            `;

            return { sql, params };
        };

        const qF2 = buildQueryEmp2('F', '4239');
        const qR2 = buildQueryEmp2('R', '4239');

        // 1. Ejecución escalonada: Primero Empresa 02 + Catálogo Maestro desde caché
        const [f2, r2, catalogoMaestro] = await Promise.all([
            db.query(qF2.sql, qF2.params),
            db.query(qR2.sql, qR2.params),
            hayFiltroProducto ? obtenerCatalogoMaestroCacheado() : Promise.resolve([])
        ]);

        // 2. Ejecución de Empresa 03 (se omite únicamente si el almacén es exclusivo de Empresa 02: Durango o Querétaro)
        let f3 = [];
        let r3 = [];
        if (!esSoloEmpresa02) {
            const qF3 = buildQueryEmp3('F', '2257');
            const qR3 = buildQueryEmp3('R', '2257');
            [f3, r3] = await Promise.all([
                db3.query(qF3.sql, qF3.params),
                db3.query(qR3.sql, qR3.params)
            ]);
        }

        // Construir Set de claves válidas del Catálogo Maestro desde la caché en memoria
        let setClavesMaestro = null;
        if (hayFiltroProducto) {
            setClavesMaestro = new Set();
            catalogoMaestro.forEach(item => {
                if (genero && item.GENERO !== genero) return;
                if (familia && item.FAMILIA !== familia) return;
                if (linea && item.LINEA !== linea) return;
                setClavesMaestro.add(item.CVE_ART);
            });
        }

        const nombresMeses = ["Ene", "Feb", "Mar", "Abr", "May", "Jun", "Jul", "Ago", "Sep", "Oct", "Nov", "Dic"];
        const anioCorto = String(anio).slice(-2);

        // Inicializar estructura de meses (1..12 o solo el mes filtrado si se especificó)
        const mesesIndices = mesFiltro ? [mesFiltro] : [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
        const acumuladorMeses = {};

        mesesIndices.forEach(m => {
            acumuladorMeses[m] = {
                mes: m,
                etiqueta: `${nombresMeses[m - 1]} ${anioCorto}`,
                subtotal: 0,
                partidas: 0
            };
        });

        const pasaFiltroAlmacen = (idSucursalMapeado) => {
            const nombreSucursal = ALMACENES_MAP[idSucursalMapeado];
            if (!nombreSucursal) return false;
            if (!filtroAlmacen) return true;

            const targetId = filtroAlmacen === '3' ? '10' : filtroAlmacen;
            return (
                String(idSucursalMapeado) === targetId ||
                nombreSucursal.toUpperCase() === filtroAlmacen.toUpperCase()
            );
        };

        // Acumular resultados de Empresa 02
        [...f2, ...r2].forEach(row => {
            const idSuc = String(row.NUM_ALMA);
            const m = parseInt(row.MES);
            if (acumuladorMeses[m] && pasaFiltroAlmacen(idSuc)) {
                acumuladorMeses[m].subtotal = round2(acumuladorMeses[m].subtotal + (row.SUBTOTAL || 0));
                acumuladorMeses[m].partidas += parseInt(row.PARTIDAS || 0, 10);
            }
        });

        // Acumular resultados de Empresa 03 (mapeando almacén 3 -> 10 para Fresnillo y validando contra el Catálogo Maestro si hay filtro de producto)
        [...f3, ...r3].forEach(row => {
            const idSuc = String(row.NUM_ALMA) === '3' ? '10' : String(row.NUM_ALMA);
            const m = parseInt(row.MES);
            const pasaCatalogoMaestro = !setClavesMaestro || setClavesMaestro.has(row.CVE_ART);
            if (acumuladorMeses[m] && pasaFiltroAlmacen(idSuc) && pasaCatalogoMaestro) {
                acumuladorMeses[m].subtotal = round2(acumuladorMeses[m].subtotal + (row.SUBTOTAL || 0));
                acumuladorMeses[m].partidas += parseInt(row.PARTIDAS || 0, 10);
            }
        });

        res.json(mesesIndices.map(m => acumuladorMeses[m]));

    } catch (error) {
        console.error("Error en /api/dashboard/ventas-partidas-mensual:", error.message);
        res.status(500).json({
            error: "Error al calcular la serie mensual de ventas y partidas",
            detalle: error.message
        });
    }
});

/**
 * GET /api/dashboard/ventas-partidas-descarga
 * Descarga todas las partidas individuales que conforman el indicador mostrado en las gráficas.
 * Recibe exactamente los mismos parámetros que /ventas-partidas-mensual:
 * ?almacen=&tipo_venta=&genero=&familia=&linea=&mes=&anio=
 */
router.get('/ventas-partidas-descarga', async (req, res) => {
    const now = new Date();
    const anio = parseInt(req.query.anio) || now.getFullYear();

    const rawMes = req.query.mes;
    const mesFiltro = (rawMes && String(rawMes).toUpperCase() !== 'TODOS' && parseInt(rawMes) >= 1 && parseInt(rawMes) <= 12)
        ? parseInt(rawMes)
        : null;

    const rawAlmacen = req.query.almacen || req.query.sucursal;
    const filtroAlmacen = (rawAlmacen && String(rawAlmacen).toUpperCase() !== 'TODOS' && String(rawAlmacen).trim() !== '')
        ? String(rawAlmacen).trim()
        : null;

    const rawTipoVenta = req.query.tipo_venta || req.query.tipo_cliente;
    const tipoVenta = (rawTipoVenta && String(rawTipoVenta).toUpperCase() !== 'TODOS' && String(rawTipoVenta).trim() !== '')
        ? String(rawTipoVenta).trim().toUpperCase()
        : null;

    const genero = (req.query.genero && String(req.query.genero).toUpperCase() !== 'TODOS' && String(req.query.genero).trim() !== '')
        ? String(req.query.genero).trim().toUpperCase()
        : null;

    const familia = (req.query.familia && String(req.query.familia).toUpperCase() !== 'TODOS' && String(req.query.familia).trim() !== '')
        ? String(req.query.familia).trim().toUpperCase()
        : null;

    const linea = (req.query.linea && String(req.query.linea).toUpperCase() !== 'TODOS' && String(req.query.linea).trim() !== '')
        ? String(req.query.linea).trim().toUpperCase()
        : null;

    const almUpper = filtroAlmacen ? filtroAlmacen.toUpperCase() : '';
    const esSoloEmpresa02 = almUpper === '1' || almUpper === '7' || almUpper === 'DURANGO' || almUpper === 'QUERÉTARO' || almUpper === 'QUERETARO';

    try {
        const buildQueryDescarga = (sufijo, tipoDoc, clienteExcluido) => {
            const tablaDoc = tipoDoc === 'F' ? `FACTF${sufijo}` : `FACTR${sufijo}`;
            const tablaPar = tipoDoc === 'F' ? `PAR_FACTF${sufijo}` : `PAR_FACTR${sufijo}`;
            const tablaClie = `CLIE${sufijo}`;

            const where = [
                `D.TIP_DOC = '${tipoDoc}'`,
                `D.STATUS <> 'C'`,
                `TRIM(D.CVE_CLPV) <> '${clienteExcluido}'`,
                `UPPER(TRIM(P.CVE_ART)) <> 'ENVIO'`,
                `EXTRACT(YEAR FROM D.FECHA_DOC) = ?`
            ];
            const params = [anio];

            if (tipoDoc === 'R') {
                where.push(`(COALESCE(D.TIP_DOC_SIG, '') <> 'F')`);
            }

            if (mesFiltro) {
                where.push(`EXTRACT(MONTH FROM D.FECHA_DOC) = ?`);
                params.push(mesFiltro);
            }

            if (tipoVenta === 'CREDITO' || tipoVenta === 'CRÉDITO' || tipoVenta === 'S') {
                where.push(`UPPER(TRIM(COALESCE(CL.CON_CREDITO, 'N'))) = 'S'`);
            } else if (tipoVenta === 'CONTADO' || tipoVenta === 'N') {
                where.push(`UPPER(TRIM(COALESCE(CL.CON_CREDITO, 'N'))) = 'N'`);
            }

            const sql = `
                SELECT
                    TRIM(D.CVE_DOC) AS FOLIO,
                    D.TIP_DOC,
                    D.FECHA_DOC,
                    EXTRACT(MONTH FROM D.FECHA_DOC) AS MES,
                    D.STATUS,
                    TRIM(D.CVE_CLPV) AS CLIENTE,
                    TRIM(COALESCE(CL.NOMBRE, '')) AS NOMBRE_CLIENTE,
                    UPPER(TRIM(COALESCE(CL.CON_CREDITO, 'N'))) AS CON_CREDITO,
                    D.NUM_ALMA,
                    P.NUM_PAR,
                    TRIM(P.CVE_ART) AS CVE_ART,
                    P.CANT,
                    P.PREC,
                    COALESCE(P.DESC1, 0) AS DESC1,
                    COALESCE(P.DESC2, 0) AS DESC2,
                    COALESCE(P.DESC3, 0) AS DESC3,
                    P.TOT_PARTIDA,
                    COALESCE(P.TOTIMP4, 0) AS TOTIMP4
                FROM ${tablaDoc} D
                INNER JOIN ${tablaPar} P ON D.CVE_DOC = P.CVE_DOC
                LEFT JOIN ${tablaClie} CL ON D.CVE_CLPV = CL.CLAVE
                WHERE ${where.join(' AND ')}
                ORDER BY D.FECHA_DOC ASC, D.CVE_DOC ASC, P.NUM_PAR ASC
            `;

            return { sql, params };
        };

        const qF2 = buildQueryDescarga('02', 'F', '4239');
        const qR2 = buildQueryDescarga('02', 'R', '4239');

        // 1. Ejecución escalonada: Primero Empresa 02 + Catálogo Maestro desde caché
        const [f2, r2, catalogoMaestro] = await Promise.all([
            db.query(qF2.sql, qF2.params),
            db.query(qR2.sql, qR2.params),
            obtenerCatalogoMaestroCacheado()
        ]);

        // 2. Ejecución de Empresa 03 (se omite únicamente si el almacén es Durango o Querétaro)
        let f3 = [];
        let r3 = [];
        if (!esSoloEmpresa02) {
            const qF3 = buildQueryDescarga('03', 'F', '2257');
            const qR3 = buildQueryDescarga('03', 'R', '2257');
            [f3, r3] = await Promise.all([
                db3.query(qF3.sql, qF3.params),
                db3.query(qR3.sql, qR3.params)
            ]);
        }

        // Mapa del Catálogo Maestro (Empresa 02) por CVE_ART para enriquecer y filtrar ambas empresas por igual
        const catalogoMap = new Map();
        catalogoMaestro.forEach(item => {
            catalogoMap.set(item.CVE_ART, item);
        });

        const pasaFiltroAlmacen = (idSucursalMapeado) => {
            const nombreSucursal = ALMACENES_MAP[idSucursalMapeado];
            if (!nombreSucursal) return false;
            if (!filtroAlmacen) return true;

            const targetId = filtroAlmacen === '3' ? '10' : filtroAlmacen;
            return (
                String(idSucursalMapeado) === targetId ||
                nombreSucursal.toUpperCase() === filtroAlmacen.toUpperCase()
            );
        };

        const pasaFiltroProducto = (catInfo) => {
            if (!genero && !familia && !linea) return true;
            if (!catInfo) return false;
            if (genero && catInfo.GENERO !== genero) return false;
            if (familia && catInfo.FAMILIA !== familia) return false;
            if (linea && catInfo.LINEA !== linea) return false;
            return true;
        };

        const partidas = [];

        const agregarPartida = (row, empresa, idSucursalMapeado) => {
            if (!pasaFiltroAlmacen(idSucursalMapeado)) return;

            const catInfo = catalogoMap.get(row.CVE_ART) || null;
            if (!pasaFiltroProducto(catInfo)) return;

            partidas.push({
                empresa,
                tipo_doc: row.TIP_DOC ? row.TIP_DOC.trim() : '',
                folio: row.FOLIO,
                fecha: row.FECHA_DOC,
                mes: parseInt(row.MES, 10),
                anio,
                status: row.STATUS ? row.STATUS.trim() : '',
                cliente: row.CLIENTE,
                nombre_cliente: row.NOMBRE_CLIENTE,
                tipo_venta: row.CON_CREDITO === 'S' ? 'CREDITO' : 'CONTADO',
                num_alma: row.NUM_ALMA,
                id_sucursal: parseInt(idSucursalMapeado, 10),
                sucursal: ALMACENES_MAP[idSucursalMapeado],
                num_par: row.NUM_PAR,
                CVE_ART: row.CVE_ART,
                cve_art: row.CVE_ART,
                descripcion: catInfo ? catInfo.DESCR : '',
                genero: catInfo ? catInfo.GENERO : '',
                familia: catInfo ? catInfo.FAMILIA : '',
                linea: catInfo ? catInfo.LINEA : '',
                cantidad: row.CANT || 0,
                precio_unitario: round2(row.PREC || 0),
                desc1: row.DESC1 || 0,
                desc2: row.DESC2 || 0,
                desc3: row.DESC3 || 0,
                subtotal_partida: round2(row.TOT_PARTIDA || 0),
                iva_partida: round2(row.TOTIMP4 || 0)
            });
        };

        // Procesar Empresa 02
        [...f2, ...r2].forEach(row => {
            const idSuc = String(row.NUM_ALMA);
            agregarPartida(row, 'Empresa 02', idSuc);
        });

        // Procesar Empresa 03 (mapeando almacén 3 -> 10 para Fresnillo)
        [...f3, ...r3].forEach(row => {
            const idSuc = String(row.NUM_ALMA) === '3' ? '10' : String(row.NUM_ALMA);
            agregarPartida(row, 'Empresa 03', idSuc);
        });

        let subtotalTotal = 0;
        partidas.forEach(p => {
            subtotalTotal += p.subtotal_partida;
        });

        res.json({
            filtros_aplicados: {
                almacen: filtroAlmacen || 'TODOS',
                tipo_venta: tipoVenta || 'TODOS',
                genero: genero || 'TODOS',
                familia: familia || 'TODOS',
                linea: linea || 'TODOS',
                mes: mesFiltro || 'TODOS',
                anio
            },
            total_partidas: partidas.length,
            subtotal_total: round2(subtotalTotal),
            partidas
        });

    } catch (error) {
        console.error("Error en /api/dashboard/ventas-partidas-descarga:", error.message);
        res.status(500).json({
            error: "Error al descargar el detalle de partidas filtradas",
            detalle: error.message
        });
    }
});

module.exports = router;