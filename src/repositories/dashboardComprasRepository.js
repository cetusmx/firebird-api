const db = require('../db');   
const db3 = require('../db3'); 

const obtenerComprasConsolidadas = async (filtros) => {
    console.log(`[REPO-START] Iniciando consulta con filtros:`, filtros);
    
    const { mes, anio, almacen, linea, perfil, genero, familia } = filtros;
    let whereClauses = ["C.STATUS <> 'C'"];
    let params = [];

    if (mes) {
        whereClauses.push("EXTRACT(MONTH FROM C.FECHA_DOC) = ?");
        params.push(mes);
    }
    if (anio) {
        whereClauses.push("EXTRACT(YEAR FROM C.FECHA_DOC) = ?");
        params.push(anio);
    }
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
        INNER JOIN MINVE02 M ON TRIM(M.REFER) = TRIM(C.CVE_DOC)
        LEFT JOIN INVE02 I ON TRIM(I.CVE_ART) = TRIM(M.CVE_ART)
        LEFT JOIN INVE_CLIB02 L ON TRIM(L.CVE_PROD) = TRIM(M.CVE_ART)
        ${whereString}
    `;

    const buildSql = (sufijo) => {
        return sql
            .replace(/COMPC02/g, `COMPC${sufijo}`)
            .replace(/MINVE02/g, `MINVE${sufijo}`)
            .replace(/INVE02/g, `INVE${sufijo}`)
            .replace(/INVE_CLIB02/g, `INVE_CLIB${sufijo}`);
    };

    console.log(`[REPO-SQL] Query generado. Parámetros a inyectar:`, params);
    console.log(`[REPO-SQL] Lanzando consultas a DB2 y DB3 en paralelo...`);

    // Aislamos las promesas para ver cuál de las dos bases de datos se queda colgada
    const consultaEmpresa2 = db.query(buildSql('02'), params)
        .then(res => {
            console.log(`[REPO-DB2] ✅ Respondió Empresa 2 con ${res.length} registros.`);
            return res;
        }).catch(err => {
            console.error(`[REPO-DB2] ❌ Error en Empresa 2:`, err);
            throw err;
        });

    const consultaEmpresa3 = db3.query(buildSql('03'), params)
        .then(res => {
            console.log(`[REPO-DB3] ✅ Respondió Empresa 3 con ${res.length} registros.`);
            return res;
        }).catch(err => {
            console.error(`[REPO-DB3] ❌ Error en Empresa 3:`, err);
            throw err;
        });

    const [res2, res3] = await Promise.all([consultaEmpresa2, consultaEmpresa3]);

    console.log(`[REPO-MERGE] Ambas BD respondieron. Mapeando Empresa 3...`);
    const res3Mapeado = res3.map(row => ({ ...row, Almacen: 3 }));
    let consolidados = [...res2, ...res3Mapeado];

    if (almacen) {
        consolidados = consolidados.filter(r => String(r.Almacen) === String(almacen));
    }

    console.log(`[REPO-END] Finalizando con ${consolidados.length} registros consolidados.`);
    return consolidados;
};

module.exports = { obtenerComprasConsolidadas };