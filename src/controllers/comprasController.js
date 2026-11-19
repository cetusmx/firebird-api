const db = require('../db');
const db3 = require('../db3');
const repo = require('../repositories/comprasRepository');

const ALMACENES_CODIGOS = ['1', '3', '5', '6', '7'];
const ULTIMAS_VENTAS_TTL_MS = 15 * 60 * 1000;

// Caché en memoria de últimas ventas por ventana de meses: Map<number, { ventasMap, timestamp, buildMs, detalles }>
const ultimasVentasCache = new Map();
const ultimasVentasInFlight = new Map();

const toTrimmedOrNull = (val) => {
    if (val === null || val === undefined) return null;
    const str = String(val).trim();
    return str === '' ? null : str;
};

const parseMedida = (val) => {
    if (val === null || val === undefined) return null;
    const str = String(val).trim().replace(',', '.');
    if (str === '') return null;
    const num = Number(str);
    return Number.isFinite(num) ? num : null;
};

const parseProveedor = (val) => {
    const str = toTrimmedOrNull(val);
    if (str === null) return null;
    return /^[1-9]\d*$/.test(str) ? Number(str) : str;
};

const toIsoDateOrNull = (val) => {
    if (!val) return null;
    const d = val instanceof Date ? val : new Date(val);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

const toNumberOrNull = (val) => {
    if (val === null || val === undefined) return null;
    const num = Number(val);
    return Number.isFinite(num) ? num : null;
};

/**
 * Indexa el movimiento de compra más reciente (ORDER BY NUM_MOV DESC) por SKU,
 * priorizando el último movimiento que tenga COSTO > 0.
 */
function indexarUltimaCompraMinve(rows) {
    const latestWithCost = new Map();
    const latestAny = new Map();

    rows.forEach(r => {
        if (!latestAny.has(r.CVE_ART)) {
            latestAny.set(r.CVE_ART, r);
        }
        const costo = Number(r.COSTO);
        if (Number.isFinite(costo) && costo > 0 && !latestWithCost.has(r.CVE_ART)) {
            latestWithCost.set(r.CVE_ART, r);
        }
    });

    const result = new Map();
    latestAny.forEach((row, sku) => {
        result.set(sku, latestWithCost.get(sku) || row);
    });
    return result;
}

/**
 * Construye el objeto de compra para una empresa consolidando INVE + MINVE (CVE_CPTO = 1).
 */
function buildCompraEmpresa(inveRow, minveRow) {
    if (!inveRow && !minveRow) {
        return {
            ULT_COSTO: null,
            ULTIMO_PROVEEDOR: null,
            FCH_ULTCOM: null
        };
    }

    const minveCosto = toNumberOrNull(minveRow?.COSTO);
    const inveCosto = toNumberOrNull(inveRow?.ULT_COSTO);

    let ultCosto = null;
    if (minveCosto !== null && minveCosto > 0) {
        ultCosto = minveCosto;
    } else if (inveCosto !== null && inveCosto > 0) {
        ultCosto = inveCosto;
    } else if (minveCosto !== null) {
        ultCosto = minveCosto;
    } else if (inveCosto !== null) {
        ultCosto = inveCosto;
    }

    const ultProveedor = minveRow ? parseProveedor(minveRow.CLAVE_CLPV) : null;
    const fchUltcom = toIsoDateOrNull(inveRow?.FCH_ULTCOM) || toIsoDateOrNull(minveRow?.FECHA_DOCU) || null;

    if (ultProveedor === null && fchUltcom === null && (ultCosto === null || ultCosto === 0)) {
        return {
            ULT_COSTO: null,
            ULTIMO_PROVEEDOR: null,
            FCH_ULTCOM: null
        };
    }

    return {
        ULT_COSTO: ultCosto,
        ULTIMO_PROVEEDOR: ultProveedor,
        FCH_ULTCOM: fchUltcom
    };
}

/**
 * Selecciona la compra más reciente entre Empresa 02 y Empresa 03,
 * priorizando aquella con costo > 0 y comparando FCH_ULTCOM.
 */
function seleccionarCompraPrincipal(c02, c03) {
    const tieneCosto02 = c02.ULT_COSTO !== null && c02.ULT_COSTO > 0;
    const tieneCosto03 = c03.ULT_COSTO !== null && c03.ULT_COSTO > 0;

    if (tieneCosto02 && !tieneCosto03) return c02;
    if (tieneCosto03 && !tieneCosto02) return c03;

    const time02 = c02.FCH_ULTCOM ? new Date(c02.FCH_ULTCOM).getTime() : 0;
    const time03 = c03.FCH_ULTCOM ? new Date(c03.FCH_ULTCOM).getTime() : 0;

    if (time03 > time02) return c03;
    if (time02 > time03) return c02;

    if (c03.ULTIMO_PROVEEDOR !== null && c02.ULTIMO_PROVEEDOR === null) return c03;
    return c02;
}

/**
 * Obtiene (o calcula en una única pasada global y cachea por 15 min) el MAX(FECHA_DOC)
 * de ventas en facturas y remisiones para los últimos N meses.
 */
async function obtenerUltimasVentasCacheadas(mesesHistorial, forzarRecarga = false) {
    const ahora = Date.now();
    const cached = ultimasVentasCache.get(mesesHistorial);
    if (!forzarRecarga && cached && (ahora - cached.timestamp) < ULTIMAS_VENTAS_TTL_MS) {
        return { ventasMap: cached.ventasMap, cacheHit: true, detalles: cached.detalles };
    }

    if (!forzarRecarga && ultimasVentasInFlight.has(mesesHistorial)) {
        const resFlight = await ultimasVentasInFlight.get(mesesHistorial);
        return { ventasMap: resFlight.ventasMap, cacheHit: true, detalles: resFlight.detalles };
    }

    const cargaPromise = (async () => {
        const tInicio = Date.now();
        const detalles = {};
        const medir = async (label, fn) => {
            const t0 = Date.now();
            const rows = await fn();
            detalles[label] = `${Date.now() - t0} ms (${rows.length} filas)`;
            return rows;
        };

        const fechaCorte = new Date();
        fechaCorte.setMonth(fechaCorte.getMonth() - mesesHistorial);
        const fechaCorteStr = fechaCorte.toISOString().split('T')[0];

        const [ventasF02Rows, ventasF03Rows] = await Promise.all([
            medir('FACTF02_global', () => repo.obtenerMaxFechaVentasGlobal(db, 'FACTF02', 'PAR_FACTF02', 'F', [1, 5, 6, 7], fechaCorteStr)),
            medir('FACTF03_global', () => repo.obtenerMaxFechaVentasGlobal(db3, 'FACTF03', 'PAR_FACTF03', 'F', [3, 5, 6], fechaCorteStr))
        ]);

        const [ventasR02Rows, ventasR03Rows] = await Promise.all([
            medir('FACTR02_global', () => repo.obtenerMaxFechaVentasGlobal(db, 'FACTR02', 'PAR_FACTR02', 'R', [1, 5, 6, 7], fechaCorteStr)),
            medir('FACTR03_global', () => repo.obtenerMaxFechaVentasGlobal(db3, 'FACTR03', 'PAR_FACTR03', 'R', [3, 5, 6], fechaCorteStr))
        ]);

        const ventasMap = new Map();
        const registrarVenta = (sku, almCode, fechaDoc) => {
            if (!sku) return;
            const iso = toIsoDateOrNull(fechaDoc);
            if (!iso) return;

            const code = String(almCode);
            if (!ALMACENES_CODIGOS.includes(code)) return;

            if (!ventasMap.has(sku)) {
                ventasMap.set(sku, { '1': null, '3': null, '5': null, '6': null, '7': null });
            }

            const registro = ventasMap.get(sku);
            const currentIso = registro[code];
            if (!currentIso || new Date(iso).getTime() > new Date(currentIso).getTime()) {
                registro[code] = iso;
            }
        };

        [...ventasF02Rows, ...ventasR02Rows, ...ventasF03Rows, ...ventasR03Rows].forEach(r => {
            registrarVenta(r.CVE_ART, r.NUM_ALMA, r.MAX_FECHA);
        });

        const buildMs = Date.now() - tInicio;
        console.log(`[ultimas-ventas-cache] Recargado (${mesesHistorial}m, ${ventasMap.size} SKUs) en ${buildMs} ms`, detalles);

        const entry = { ventasMap, timestamp: Date.now(), buildMs, detalles };
        ultimasVentasCache.set(mesesHistorial, entry);
        return entry;
    })();

    ultimasVentasInFlight.set(mesesHistorial, cargaPromise);
    try {
        const entry = await cargaPromise;
        return { ventasMap: entry.ventasMap, cacheHit: false, detalles: entry.detalles };
    } finally {
        ultimasVentasInFlight.delete(mesesHistorial);
    }
}

/**
 * GET /api/compras/reposicion/ultimas-ventas
 * Devuelve el diccionario cacheado de MAX(FECHA_DOC) por SKU y almacén ("1","3","5","6","7").
 */
const getUltimasVentasReposicion = async (req, res) => {
    try {
        const rawMeses = req.query.meses ?? req.query.meses_historial_ventas;
        let mesesHistorial = 12;

        if (rawMeses !== undefined && String(rawMeses).trim() !== '') {
            const parsed = Number(rawMeses);
            if (!Number.isInteger(parsed) || parsed < 1) {
                return res.status(400).json({
                    ok: false,
                    error: "El campo 'meses_historial_ventas' debe ser un entero mayor o igual a 1."
                });
            }
            mesesHistorial = parsed;
        }

        const forzarRecarga = req.query.forzar_recarga === 'true';
        const { ventasMap, cacheHit } = await obtenerUltimasVentasCacheadas(mesesHistorial, forzarRecarga);

        return res.json({
            ok: true,
            fecha_consulta: new Date().toISOString(),
            meses_historial_ventas: mesesHistorial,
            cache_hit: cacheHit,
            total: ventasMap.size,
            ultimas_ventas: Object.fromEntries(ventasMap)
        });
    } catch (error) {
        console.error('Error en GET /api/compras/reposicion/ultimas-ventas:', error.message);
        return res.status(500).json({
            ok: false,
            error: 'Error al consultar el historial de últimas ventas en SAE.'
        });
    }
};

/**
 * POST /api/compras/reposicion/datos-sae
 * Devuelve datos puros de SAE (catálogo unificado db + db3, compras por empresa, existencias y últimas ventas)
 * para el cálculo de reposición de mercancías. Soporta entrada por 'lineas' o por 'claves'.
 */
const getDatosSaeReposicion = async (req, res) => {
    try {
        const {
            lineas,
            claves,
            meses_historial_ventas,
            incluir_ultimas_ventas = true,
            forzar_recarga_ventas = false
        } = req.body || {};

        let lineasLimpias = [];
        let clavesLimpias = [];
        const usaClaves = claves !== undefined;

        if (usaClaves) {
            if (!Array.isArray(claves) || claves.length === 0) {
                return res.status(400).json({
                    ok: false,
                    error: "El campo 'claves' debe ser un arreglo no vacío."
                });
            }
            clavesLimpias = [...new Set(
                claves
                    .filter(c => typeof c === 'string' && c.trim() !== '')
                    .map(c => c.trim())
            )];
            if (clavesLimpias.length === 0) {
                return res.status(400).json({
                    ok: false,
                    error: "El campo 'claves' debe ser un arreglo no vacío."
                });
            }
        } else {
            if (!Array.isArray(lineas) || lineas.length === 0) {
                return res.status(400).json({
                    ok: false,
                    error: "El campo 'lineas' debe ser un arreglo no vacío."
                });
            }
            lineasLimpias = [...new Set(
                lineas
                    .filter(l => typeof l === 'string' && l.trim() !== '')
                    .map(l => l.trim().toUpperCase())
            )];
            if (lineasLimpias.length === 0) {
                return res.status(400).json({
                    ok: false,
                    error: "El campo 'lineas' debe ser un arreglo no vacío."
                });
            }
        }

        const mesesHistorial = meses_historial_ventas === undefined ? 12 : meses_historial_ventas;
        if (typeof mesesHistorial !== 'number' || !Number.isInteger(mesesHistorial) || mesesHistorial < 1) {
            return res.status(400).json({
                ok: false,
                error: "El campo 'meses_historial_ventas' debe ser un entero mayor o igual a 1."
            });
        }

        const tInicioTotal = Date.now();
        const tiempos = {};
        const medir = async (etiqueta, fn) => {
            const t0 = Date.now();
            const resFn = await fn();
            const ms = Date.now() - t0;
            tiempos[etiqueta] = `${ms} ms (${Array.isArray(resFn) ? resFn.length : 'obj'} filas)`;
            return resFn;
        };

        // 1. Obtener catálogo activo de ambas empresas (por claves o por líneas)
        const productosEmp02 = usaClaves
            ? await medir('INVE02', () => repo.obtenerProductosPorClavesEmp02(clavesLimpias))
            : await medir('INVE02', () => repo.obtenerProductosEmpresa02(lineasLimpias));

        const productosEmp03 = usaClaves
            ? await medir('INVE03', () => repo.obtenerProductosPorClavesEmp03(clavesLimpias))
            : await medir('INVE03', () => repo.obtenerProductosEmpresa03(lineasLimpias));

        // Unificar por CVE_ART: Empresa 02 funge como catálogo maestro; Empresa 03 complementa si hubiera SKUs exclusivos
        const inve02Map = new Map();
        const inve03Map = new Map();
        const catalogoUnificado = new Map();

        productosEmp02.forEach(row => {
            inve02Map.set(row.CVE_ART, row);
            catalogoUnificado.set(row.CVE_ART, row);
        });

        productosEmp03.forEach(row => {
            inve03Map.set(row.CVE_ART, row);
            if (!catalogoUnificado.has(row.CVE_ART)) {
                catalogoUnificado.set(row.CVE_ART, row);
            }
        });

        if (catalogoUnificado.size === 0) {
            return res.json({
                ok: true,
                fecha_consulta: new Date().toISOString(),
                total: 0,
                productos: []
            });
        }

        const allSkus = Array.from(catalogoUnificado.keys());
        const skuSet = new Set(allSkus);

        // Completar info de INVE03 (ULT_COSTO, FCH_ULTCOM) para SKUs que existan en 02 pero tuvieran distinta línea en 03
        const skusFaltantesInve03 = allSkus.filter(sku => !inve03Map.has(sku));
        if (skusFaltantesInve03.length > 0) {
            const extraInve03 = await medir('INVE03_extra', () => repo.obtenerInve03PorClaves(skusFaltantesInve03));
            extraInve03.forEach(row => inve03Map.set(row.CVE_ART, row));
        }

        // 2. Existencias y Compras en pares (db + db3), con MULT03 global y MINVE sin auto-join
        const [exist02Rows, exist03Rows] = await Promise.all([
            medir('MULT02', () => repo.obtenerExistenciasEmp02(allSkus)),
            medir('MULT03_global', () => repo.obtenerExistenciasEmp03Global())
        ]);

        const [minve02Rows, minve03Rows] = await Promise.all([
            medir('MINVE02', () => repo.obtenerUltimasComprasMinve(db, 'MINVE02', allSkus)),
            medir('MINVE03', () => repo.obtenerUltimasComprasMinve(db3, 'MINVE03', allSkus))
        ]);

        // 3. Últimas ventas desde caché global en RAM (o desactivadas si incluir_ultimas_ventas === false)
        let ventasMap = new Map();
        if (incluir_ultimas_ventas !== false) {
            const tVentas0 = Date.now();
            const resVentas = await obtenerUltimasVentasCacheadas(mesesHistorial, Boolean(forzar_recarga_ventas));
            ventasMap = resVentas.ventasMap;
            tiempos['VENTAS'] = `${Date.now() - tVentas0} ms (cacheHit=${resVentas.cacheHit})`;
        }

        // 4. Indexar existencias en memoria
        const existenciasMap = new Map();
        const setExistencia = (sku, almCode, existVal) => {
            if (!existenciasMap.has(sku)) {
                existenciasMap.set(sku, { '1': 0, '3': 0, '5': 0, '6': 0, '7': 0 });
            }
            const code = String(almCode);
            if (ALMACENES_CODIGOS.includes(code)) {
                const num = Number(existVal);
                existenciasMap.get(sku)[code] = Number.isFinite(num) ? num : 0;
            }
        };

        exist02Rows.forEach(r => setExistencia(r.CVE_ART, r.CVE_ALM, r.EXIST));
        exist03Rows.forEach(r => {
            if (skuSet.has(r.CVE_ART)) {
                setExistencia(r.CVE_ART, r.CVE_ALM, r.EXIST);
            }
        });

        // 5. Indexar movimientos de última compra MINVE (priorizando COSTO > 0)
        const minve02Map = indexarUltimaCompraMinve(minve02Rows);
        const minve03Map = indexarUltimaCompraMinve(minve03Rows);

        // 6. Construir respuesta consolidada ordenada por CVE_ART
        const skusOrdenados = allSkus.sort((a, b) => a.localeCompare(b));

        const productos = skusOrdenados.map(sku => {
            const base = catalogoUnificado.get(sku);
            const compra02 = buildCompraEmpresa(inve02Map.get(sku), minve02Map.get(sku));
            const compra03 = buildCompraEmpresa(inve03Map.get(sku), minve03Map.get(sku));
            const compraPrincipal = seleccionarCompraPrincipal(compra02, compra03);

            return {
                CVE_ART: sku,
                DESCR: toTrimmedOrNull(base.DESCR) || '',
                FAMILIA: toTrimmedOrNull(base.FAMILIA),
                LIN_PROD: toTrimmedOrNull(base.LIN_PROD) || '',
                PERFIL: toTrimmedOrNull(base.PERFIL),
                DIAM_INT: parseMedida(base.DIAM_INT),
                DIAM_EXT: parseMedida(base.DIAM_EXT),
                ALTURA: parseMedida(base.ALTURA),
                SECCION: parseMedida(base.SECCION),
                SIST_MED: toTrimmedOrNull(base.SIST_MED) || '',
                ULT_COSTO: compraPrincipal.ULT_COSTO,
                ULTIMO_PROVEEDOR: compraPrincipal.ULTIMO_PROVEEDOR,
                FCH_ULTCOM: compraPrincipal.FCH_ULTCOM,
                compras_por_empresa: {
                    '02': compra02,
                    '03': compra03
                },
                existencias: existenciasMap.get(sku) || { '1': 0, '3': 0, '5': 0, '6': 0, '7': 0 },
                ultimas_ventas: ventasMap.get(sku) || { '1': null, '3': null, '5': null, '6': null, '7': null }
            };
        });

        console.log(`[datos-sae] Modo: ${usaClaves ? 'claves' : 'lineas'} | SKUs: ${productos.length} | Total: ${Date.now() - tInicioTotal} ms`, tiempos);

        return res.json({
            ok: true,
            fecha_consulta: new Date().toISOString(),
            total: productos.length,
            productos
        });
    } catch (error) {
        console.error('Error en POST /api/compras/reposicion/datos-sae:', error.message);
        return res.status(500).json({
            ok: false,
            error: 'Error al consultar los datos de SAE para reposición.'
        });
    }
};

module.exports = {
    getDatosSaeReposicion,
    getUltimasVentasReposicion
};
