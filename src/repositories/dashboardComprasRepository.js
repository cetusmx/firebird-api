const db = require('../db');   // Empresa 2
const db3 = require('../db3'); // Empresa 3

/**
 * PRUEBA DE RENDIMIENTO: Divide y Vencerás
 * Ignora todos los filtros y extrae los 50 movimientos más recientes de compras,
 * conservando los TRIM() en las relaciones JOIN.
 */
const obtenerComprasConsolidadas = async () => {
    // Hemos eliminado la inyección de parámetros/filtros para la prueba.
    
    // Agregamos FIRST 50 y ORDER BY FECHA_DOC DESC
    const sql = `
        SELECT FIRST 50
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
        WHERE C.STATUS <> 'C'
        ORDER BY C.FECHA_DOC DESC
    `;

    // Función para cambiar el número de tabla según la empresa
    const buildSql = (sufijo) => {
        return sql
            .replace(/COMPC02/g, `COMPC${sufijo}`)
            .replace(/MINVE02/g, `MINVE${sufijo}`)
            .replace(/INVE02/g, `INVE${sufijo}`)
            .replace(/INVE_CLIB02/g, `INVE_CLIB${sufijo}`);
    };

    console.log(`[TEST-REPO] Ejecutando consulta de prueba (FIRST 50) a ambas bases de datos...`);
    const inicio = Date.now();

    // Ejecutamos ambas bases de datos en paralelo sin parámetros
    const [res2, res3] = await Promise.all([
        db.query(buildSql('02')),
        db3.query(buildSql('03'))
    ]);

    const tiempoFin = Date.now() - inicio;
    console.log(`[TEST-REPO] BBDD respondieron en ${tiempoFin}ms`);

    // Forzamos el Almacén 3 para los resultados de Fresnillo
    const res3Mapeado = res3.map(row => ({
        ...row,
        Almacen: 3
    }));

    // Combinamos los resultados (50 + 50 = 100 posibles registros)
    let consolidados = [...res2, ...res3Mapeado];

    // Ordenamos en memoria (Node.js) globalmente para asegurar que los 
    // 50 finales sean realmente los más recientes sumando ambas empresas
    consolidados.sort((a, b) => new Date(b.Fecha) - new Date(a.Fecha));

    // Devolvemos estrictamente los primeros 50 al controlador
    return consolidados.slice(0, 50);
};

module.exports = {
    obtenerComprasConsolidadas
};