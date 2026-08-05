const db = require('../db');   // Empresa 2
const db3 = require('../db3'); // Empresa 3

/**
 * Consulta las compras consolidadas con detalles de inventario y catálogos.
 */
const obtenerComprasConsolidadas = async (filtros) => {
    const { mes, anio, almacen, linea, perfil, genero, familia } = filtros;
    
    let whereClauses = ["C.STATUS <> 'C'"]; // Excluir canceladas
    let params = [];

    // Filtros de fecha (Obligatorios para no colapsar la BD)
    if (mes) {
        whereClauses.push("EXTRACT(MONTH FROM C.FECHA_DOC) = ?");
        params.push(mes);
    }
    if (anio) {
        whereClauses.push("EXTRACT(YEAR FROM C.FECHA_DOC) = ?");
        params.push(anio);
    }

    // Filtros dinámicos de producto
    if (linea) {
        whereClauses.push("TRIM(I.LIN_PROD) = ?");
        params.push(String(linea).trim().toUpperCase());
    }
    if (perfil) {
        whereClauses.push("TRIM(L.CAMPLIB13) = ?");
        params.push(String(perfil).trim().toUpperCase());
    }
    if (genero) {
        whereClauses.push("TRIM(L.CAMPLIB21) = ?");
        params.push(String(genero).trim().toUpperCase());
    }
    if (familia) {
        whereClauses.push("TRIM(L.CAMPLIB22) = ?");
        params.push(String(familia).trim().toUpperCase());
    }

    const whereString = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';

    const sql = `
        SELECT 
            TRIM(C.CVE_DOC) as "Documento",
            TRIM(C.CVE_CLPV) as "Clave Prov",
            TRIM(C.SU_REFER) as "Factura",
            C.FECHA_DOC as "Fecha",
            C.CAN_TOT as "Subtotal",  -- CORRECCIÓN AQUÍ: CAN_TOT en lugar de CANT_TOT
            TRIM(C.OBS_COND) as "Origen",
            C.NUM_ALMA as "Almacen",
            C.IMPORTE as "Importe Total",
            TRIM(M.CVE_ART) as "Clave",
            M.CVE_CPTO as "Concepto",
            M.CANT as "Cantidad",
            M.COSTO as "Costo",
            TRIM(I.DESCR) as "Descripción",
            TRIM(I.LIN_PROD) as "Línea",
            TRIM(L.CAMPLIB13) as "Perfil",
            TRIM(L.CAMPLIB21) as "Genero",
            TRIM(L.CAMPLIB22) as "Familia"
        FROM COMPC02 C
        INNER JOIN MINVE02 M ON TRIM(M.REFER) = TRIM(C.CVE_DOC)
        LEFT JOIN INVE02 I ON TRIM(I.CVE_ART) = TRIM(M.CVE_ART)
        LEFT JOIN INVE_CLIB02 L ON TRIM(L.CVE_PROD) = TRIM(M.CVE_ART)
        ${whereString}
    `;

    // Función para cambiar el número de tabla según la empresa
    const buildSql = (sufijo) => {
        return sql
            .replace(/COMPC02/g, `COMPC${sufijo}`)
            .replace(/MINVE02/g, `MINVE${sufijo}`)
            .replace(/INVE02/g, `INVE${sufijo}`)
            .replace(/INVE_CLIB02/g, `INVE_CLIB${sufijo}`);
    };

    // Ejecutamos ambas bases de datos en paralelo
    const [res2, res3] = await Promise.all([
        db.query(buildSql('02'), params),
        db3.query(buildSql('03'), params)
    ]);

    // Forzamos el Almacén 3 para los resultados de Fresnillo (Empresa 3)
    const res3Mapeado = res3.map(row => ({
        ...row,
        Almacen: 3
    }));

    let consolidados = [...res2, ...res3Mapeado];

    // Si el usuario solicitó un almacén específico por filtro, lo aplicamos en memoria
    if (almacen) {
        consolidados = consolidados.filter(r => String(r.Almacen) === String(almacen));
    }

    return consolidados;
};

module.exports = {
    obtenerComprasConsolidadas
};