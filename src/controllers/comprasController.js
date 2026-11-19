const db = require('../db');
const db3 = require('../db3');
const repo = require('../repositories/comprasRepository');

const ALMACENES_CODIGOS = ['1', '3', '5', '6', '7'];

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
 * POST /api/compras/reposicion/datos-sae
 * Devuelve datos puros de SAE (catálogo unificado db + db3, compras por empresa, existencias y últimas ventas)
 * para el cálculo de reposición de mercancías.
 */
const getDatosSaeReposicion = async (req, res) => {
    try {
        const { lineas, meses_historial_ventas } = req.body || {};

        if (!Array.isArray(lineas) || lineas.length === 0) {
            return res.status(400).json({
                ok: false,
                error: "El campo 'lineas' debe ser un arreglo no vacío."
            });
        }

        const lineasLimpias = [...new Set(
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

        const mesesHistorial = meses_historial_ventas === undefined ? 12 : meses_historial_ventas;
        if (typeof mesesHistorial !== 'number' || !Number.isInteger(mesesHistorial) || mesesHistorial < 1) {
            return res.status(400).json({
                ok: false,
                error: "El campo 'meses_historial_ventas' debe ser un entero mayor o igual a 1."
            });
        }

        // 1. Obtener catálogo activo de ambas empresas (ejecución escalonada db -> db3 para cuidar el puerto 3050)
        const productosEmp02 = await repo.obtenerProductosEmpresa02(lineasLimpias);
        const productosEmp03 = await repo.obtenerProductosEmpresa03(lineasLimpias);

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

        // Completar info de INVE03 (ULT_COSTO, FCH_ULTCOM) para SKUs que existan en 02 pero tuvieran distinta línea en 03
        const skusFaltantesInve03 = allSkus.filter(sku => !inve03Map.has(sku));
        if (skusFaltantesInve03.length > 0) {
            const extraInve03 = await repo.obtenerInve03PorClaves(skusFaltantesInve03);
            extraInve03.forEach(row => inve03Map.set(row.CVE_ART, row));
        }

        // Fecha límite hacia atrás según meses_historial_ventas
        const fechaCorte = new Date();
        fechaCorte.setMonth(fechaCorte.getMonth() - mesesHistorial);
        const fechaCorteStr = fechaCorte.toISOString().split('T')[0];

        // 2. Consultas escalonadas por pares (1 en db + 1 en db3) para no saturar Firebird
        const [exist02Rows, exist03Rows] = await Promise.all([
            repo.obtenerExistenciasEmp02(allSkus),
            repo.obtenerExistenciasEmp03(allSkus)
        ]);

        const [minve02Rows, minve03Rows] = await Promise.all([
            repo.obtenerUltimasComprasMinve(db, 'MINVE02', allSkus),
            repo.obtenerUltimasComprasMinve(db3, 'MINVE03', allSkus)
        ]);

        const [ventasF02Rows, ventasF03Rows] = await Promise.all([
            repo.obtenerMaxFechaVentas(db, 'FACTF02', 'PAR_FACTF02', 'F', [1, 5, 6, 7], fechaCorteStr, allSkus),
            repo.obtenerMaxFechaVentas(db3, 'FACTF03', 'PAR_FACTF03', 'F', [3, 5, 6], fechaCorteStr, allSkus)
        ]);

        const [ventasR02Rows, ventasR03Rows] = await Promise.all([
            repo.obtenerMaxFechaVentas(db, 'FACTR02', 'PAR_FACTR02', 'R', [1, 5, 6, 7], fechaCorteStr, allSkus),
            repo.obtenerMaxFechaVentas(db3, 'FACTR03', 'PAR_FACTR03', 'R', [3, 5, 6], fechaCorteStr, allSkus)
        ]);

        // 3. Indexar existencias en memoria
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
        exist03Rows.forEach(r => setExistencia(r.CVE_ART, r.CVE_ALM, r.EXIST));

        // 4. Indexar movimientos de última compra MINVE
        const minve02Map = new Map();
        minve02Rows.forEach(r => {
            if (!minve02Map.has(r.CVE_ART)) minve02Map.set(r.CVE_ART, r);
        });

        const minve03Map = new Map();
        minve03Rows.forEach(r => {
            if (!minve03Map.has(r.CVE_ART)) minve03Map.set(r.CVE_ART, r);
        });

        // 5. Indexar MAX(FECHA_DOC) de ventas por SKU y almacén ("1", "3", "5", "6", "7")
        const ventasMap = new Map();
        const registrarVenta = (sku, almCode, fechaDoc) => {
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
    getDatosSaeReposicion
};
