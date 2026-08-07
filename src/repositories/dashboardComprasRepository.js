const db = require('../db');   
const db3 = require('../db3'); 

const obtenerComprasConsolidadas = async (filtros) => {
    const { mes, anio } = filtros;
    
    let whereClauses = [
        "C.STATUS <> 'C'", 
        "M.CVE_CPTO = 1"
    ]; 
    let params = [];

    if (mes && anio) {
        const mesStr = String(mes).padStart(2, '0');
        const ultimoDia = new Date(anio, mes, 0).getDate(); 
        const fechaInicio = `${anio}-${mesStr}-01 00:00:00`;
        const fechaFin = `${anio}-${mesStr}-${ultimoDia} 23:59:59`;

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

    const consolidados = [...res2, ...res3Mapeado];

    // --- DEBUGGER INYECTADO AQUÍ ---
    const rastreador = consolidados.filter(r => r.Documento === 'CD2797');
    if (rastreador.length > 0) {
        console.log(`\n[REPO-DEBUG] 🟢 ¡CD2797 encontrado en SQL! Se encontraron ${rastreador.length} partidas de este documento.`);
    } else {
        console.log(`\n[REPO-DEBUG] 🔴 CD2797 NO SALIÓ DE LA BD. Verifica: ¿Es de este mes? ¿Su STATUS es 'C'? ¿Su CVE_CPTO en MINVE es diferente a 1?`);
    }
    // -------------------------------

    return consolidados;
};

module.exports = { obtenerComprasConsolidadas };