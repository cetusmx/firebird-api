const db = require('../db');   // Empresa 02 (Principal)
const db3 = require('../db3'); // Empresa 03 (Fresnillo)

/**
 * Obtiene los datos fiscales y de contacto de un cliente por su RFC.
 * Si no se especifica sucursal, busca en ambas empresas y elimina duplicados usando SOLO el RFC.
 * 
 * @param {string} rfc RFC del cliente a buscar.
 * @param {string} sucursal Opcional: '3' (Fresnillo), '1'/'2' (Principal), o vacío (Global).
 */
const buscarClientePorRFC = async (rfc, sucursal) => {
    const rfcLimpio = String(rfc).trim().toUpperCase();

    // AQUÍ ESTABA EL ERROR: Faltaba la línea WHERE TRIM(UPPER(RFC)) = ?
    const sql = `
        SELECT 
            TRIM(CLAVE) as "CLAVE",
            TRIM(NOMBRE) as "NOMBRE",
            TRIM(RFC) as "RFC",
            TRIM(CALLE) as "CALLE",
            TRIM(NUMEXT) as "NUMEXT",
            TRIM(NUMINT) as "NUMINT",
            TRIM(COLONIA) as "COLONIA",
            TRIM(LOCALIDAD) as "LOCALIDAD",
            TRIM(MUNICIPIO) as "MUNICIPIO",
            TRIM(ESTADO) as "ESTADO",
            TRIM(CODIGO) as "CODIGO",
            TRIM(PAIS) as "PAIS",
            TRIM(EMAILPRED) as "EMAILPRED",
            TRIM(NOMBRECOMERCIAL) as "NOMBRECOMERCIAL",
            TRIM(TELEFONO) as "TELEFONO",
            TRIM(STATUS) as "STATUS"
        FROM CLIE02
        WHERE TRIM(UPPER(RFC)) = ?
    `;

    // Función auxiliar para inyectar el número de tabla dinámicamente
    const buildSql = (numTabla) => sql.replace('CLIE02', `CLIE${numTabla}`);

    let resultados = [];

    // 1. Ejecución Estratégica según la petición
    if (sucursal === '3') {
        // Búsqueda exclusiva en Fresnillo
        resultados = await db3.query(buildSql('03'), [rfcLimpio]);
    } else if (sucursal === '1' || sucursal === '2') {
        // Búsqueda exclusiva en Principal
        resultados = await db.query(buildSql('02'), [rfcLimpio]);
    } else {
        // Búsqueda Global (Ambas empresas en paralelo)
        const [res2, res3] = await Promise.all([
            db.query(buildSql('02'), [rfcLimpio]),
            db3.query(buildSql('03'), [rfcLimpio])
        ]);

        const combinados = [...res2, ...res3];

        // 2. Lógica de Deduplicación (Usando estrictamente el RFC)
        const clientesUnicos = new Map();

        combinados.forEach(cliente => {
            // Utilizamos únicamente el RFC como identificador universal
            const llaveUnica = cliente.RFC;
            
            if (!clientesUnicos.has(llaveUnica)) {
                clientesUnicos.set(llaveUnica, cliente);
            }
        });

        // Convertimos el Map de vuelta a un arreglo
        resultados = Array.from(clientesUnicos.values());
    }

    return resultados;
};

module.exports = {
    buscarClientePorRFC
};