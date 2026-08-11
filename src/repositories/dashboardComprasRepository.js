const db = require('../db');   // Empresa 2
const db3 = require('../db3'); // Empresa 3

/**
 * Extrae el "Universo Total" de compras consolidadas de un rango de meses específico.
 * OPTIMIZADO: JOINs directos, Filtro estricto por Concepto = 1 y Fechas por rango (BETWEEN).
 */
const obtenerComprasConsolidadas = async (filtros) => {
    // Recibimos los nuevos parámetros de rango
    const { mes_inicio, anio_inicio, mes_fin, anio_fin } = filtros;
    
    let whereClauses = [
        "C.STATUS <> 'C'", 
        "M.CVE_CPTO = 1"
    ]; 
    let params = [];

    // Validamos que vengan los 4 parámetros del periodo
    if (mes_inicio && anio_inicio && mes_fin && anio_fin) {
        const mInicioStr = String(mes_inicio).padStart(2, '0');
        const mFinStr = String(mes_fin).padStart(2, '0');
        
        // Obtenemos el último día exacto del mes final
        const ultimoDiaFin = new Date(anio_fin, mes_fin, 0).getDate(); 
        
        // Armamos los timestamps de los extremos del periodo
        const fechaInicio = `${anio_inicio}-${mInicioStr}-01 00:00:00`;
        const fechaFin = `${anio_fin}-${mFinStr}-${ultimoDiaFin} 23:59:59`;

        whereClauses.push("C.FECHA_DOC BETWEEN ? AND ?");
        params.push(fechaInicio, fechaFin);
    }

    const whereString = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';

    const sql = `
        SELECT 
            TRIM(C.CVE_DOC) as "Documento",
            TRIM(C.CVE_CLPV) as "Clave Prov",
            TRIM(C.SU_REFER) as "Factura",
            C.FECHA_DOC as "Fecha",
            C.CAN_TOT as "Subtotal",
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
        INNER JOIN MINVE02 M ON M.REFER = C.CVE_DOC
        LEFT JOIN INVE02 I ON I.CVE_ART = M.CVE_ART
        LEFT JOIN INVE_CLIB02 L ON L.CVE_PROD = M.CVE_ART
        ${whereString}
    `;

    const buildSql = (sufijo) => {
        return sql
            .replace(/COMPC02/g, `COMPC${sufijo}`)
            .replace(/MINVE02/g, `MINVE${sufijo}`)
            .replace(/INVE02/g, `INVE${sufijo}`)
            .replace(/INVE_CLIB02/g, `INVE_CLIB${sufijo}`);
    };

    const [res2, res3] = await Promise.all([
        db.query(buildSql('02'), params),
        db3.query(buildSql('03'), params)
    ]);

    const res3Mapeado = res3.map(row => ({
        ...row,
        Almacen: 3
    }));

    return [...res2, ...res3Mapeado];
};

module.exports = {
    obtenerComprasConsolidadas
};