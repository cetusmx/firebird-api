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

const obtenerAniosVentas = async (almacen) => {
    const isGlobal = !almacen || almacen === '0' || almacen === 'null' || almacen === 'undefined' || almacen === 'todos';
    const isAlmacen3 = !isGlobal && String(almacen) === '3';

    const buildAniosQuery = (tablaFact) => {
        let sql = `SELECT DISTINCT EXTRACT(YEAR FROM FECHA_DOC) AS ANIO FROM ${tablaFact} WHERE STATUS <> 'C'`;
        const params = [];
        if (!isGlobal) {
            sql += ` AND NUM_ALMA = ?`;
            params.push(almacen);
        }
        return { sql, params };
    };

    try {
        if (isAlmacen3) {
            const q = buildAniosQuery('FACTF03');
            const res = await db3.query(q.sql, q.params);
            return res.map(r => r.ANIO).filter(a => a !== null).sort((a, b) => b - a);
        } else if (!isGlobal) {
            const q = buildAniosQuery('FACTF02');
            const res = await db.query(q.sql, q.params);
            return res.map(r => r.ANIO).filter(a => a !== null).sort((a, b) => b - a);
        } else {
            // Búsqueda global: Consultamos a ambas bases de datos al mismo tiempo
            const q2 = buildAniosQuery('FACTF02');
            const q3 = buildAniosQuery('FACTF03');
            const [res2, res3] = await Promise.all([
                db.query(q2.sql, q2.params),
                db3.query(q3.sql, q3.params)
            ]);
            
            // Unimos resultados eliminando duplicados
            const setAnios = new Set([...res2.map(r => r.ANIO), ...res3.map(r => r.ANIO)]);
            return Array.from(setAnios).filter(a => a !== null).sort((a, b) => b - a);
        }
    } catch (error) {
        console.error("Error al obtener años de ventas:", error);
        return [];
    }
};

const obtenerVentasClientes = async (almacen, cliente, anio) => {
    // Sanitizamos la bandera global para evitar errores si el frontend manda "null" o "undefined" como string
    const isGlobal = !almacen || almacen === '0' || almacen === 'null' || almacen === 'undefined' || almacen === 'todos';
    const isAlmacen3 = !isGlobal && String(almacen) === '3';

    // Función creadora dinámica de SQL según la tabla a apuntar
    const buildVentasQuery = (tablaClie, tablaFact) => {
        const params = [];
        let filtroFacturas = '';
        if (!isGlobal) {
            filtroFacturas = ` AND F.NUM_ALMA = ? `;
            // Pasamos el parámetro 3 veces (NUM_ALMA, FECHA_DOC, CAN_TOT)
            params.push(almacen, almacen, almacen);
        }

        let innerSql = `
            SELECT 
                TRIM(C.CLAVE) AS CLAVE,
                TRIM(C.NOMBRE) AS NOMBRE,
                TRIM(C.RFC) AS RFC,
                TRIM(COALESCE(C.CALLE, '')) || ' ' || TRIM(COALESCE(C.NUMEXT, '')) || ' ' || TRIM(COALESCE(C.NUMINT, '')) AS DIRECCION,
                TRIM(C.COLONIA) AS COLONIA,
                TRIM(C.CODIGO) AS CODIGO,
                TRIM(C.LOCALIDAD) AS LOCALIDAD,
                TRIM(C.MUNICIPIO) AS MUNICIPIO,
                TRIM(C.ESTADO) AS ESTADO,
                TRIM(C.TELEFONO) AS TELEFONO,
                TRIM(C.PAG_WEB) AS PAG_WEB,
                TRIM(C.EMAILPRED) AS EMAILPRED,
                C.SALDO,
                C.LISTA_PREC,
                C.FCH_ULTCOM AS FECHA_ULT_COMPRA_GENERAL,
                (SELECT FIRST 1 F.NUM_ALMA FROM ${tablaFact} F WHERE F.CVE_CLPV = C.CLAVE AND F.STATUS <> 'C' ${filtroFacturas} ORDER BY F.FECHA_DOC DESC) AS NUM_ALMA,
                (SELECT FIRST 1 F.FECHA_DOC FROM ${tablaFact} F WHERE F.CVE_CLPV = C.CLAVE AND F.STATUS <> 'C' ${filtroFacturas} ORDER BY F.FECHA_DOC DESC) AS FECHA_ULTIMA_COMPRA,
                (SELECT FIRST 1 F.CAN_TOT FROM ${tablaFact} F WHERE F.CVE_CLPV = C.CLAVE AND F.STATUS <> 'C' ${filtroFacturas} ORDER BY F.FECHA_DOC DESC) AS CANT_TOT
            FROM ${tablaClie} C
            WHERE C.STATUS = 'A'
        `;

        if (cliente) {
            innerSql += ` AND UPPER(TRIM(C.CLAVE)) CONTAINING UPPER(?)`;
            params.push(cliente);
        }

        let sql = `SELECT * FROM (${innerSql}) T`;
        let whereClauses = [];

        if (anio && anio !== 'null' && anio !== 'sin_compras' && anio !== 'undefined') {
            whereClauses.push(`EXTRACT(YEAR FROM T.FECHA_ULTIMA_COMPRA) = ?`);
            params.push(anio);
        } else if (anio === 'null' || anio === 'sin_compras') {
            whereClauses.push(`T.FECHA_ULTIMA_COMPRA IS NULL`);
        } else if (!isGlobal) {
            // Si buscamos en un almacén específico y NO pedimos inactivos, 
            // ocultamos la basura o clientes temporales que nunca le han comprado a este almacén
            whereClauses.push(`T.FECHA_ULTIMA_COMPRA IS NOT NULL`);
        }

        if (whereClauses.length > 0) {
            sql += ` WHERE ` + whereClauses.join(' AND ');
        }

        return { sql, params };
    };

    if (isAlmacen3) {
        const q = buildVentasQuery('CLIE03', 'FACTF03');
        q.sql += ` ORDER BY T.FECHA_ULTIMA_COMPRA ASC NULLS FIRST`;
        return await db3.query(q.sql, q.params);
    } else if (!isGlobal) {
        const q = buildVentasQuery('CLIE02', 'FACTF02');
        q.sql += ` ORDER BY T.FECHA_ULTIMA_COMPRA ASC NULLS FIRST`;
        return await db.query(q.sql, q.params);
    } else {
        // BÚSQUEDA GLOBAL: Consultar a DB (1,5,6,7) y DB3 (3) en paralelo
        const q2 = buildVentasQuery('CLIE02', 'FACTF02');
        const q3 = buildVentasQuery('CLIE03', 'FACTF03');
        
        const [res2, res3] = await Promise.all([
            db.query(q2.sql, q2.params),
            db3.query(q3.sql, q3.params)
        ]);

        const clientesMap = new Map();

        const procesar = (c) => {
            const clave = c.CLAVE;
            if (!clientesMap.has(clave)) {
                clientesMap.set(clave, c);
            } else {
                const existente = clientesMap.get(clave);
                const d1 = c.FECHA_ULTIMA_COMPRA ? new Date(c.FECHA_ULTIMA_COMPRA).getTime() : 0;
                const d2 = existente.FECHA_ULTIMA_COMPRA ? new Date(existente.FECHA_ULTIMA_COMPRA).getTime() : 0;
                
                // Si la fecha recién evaluada es más nueva que la que ya teníamos registrada
                if (d1 > d2) {
                    clientesMap.set(clave, {
                        ...existente,
                        FECHA_ULTIMA_COMPRA: c.FECHA_ULTIMA_COMPRA,
                        NUM_ALMA: c.NUM_ALMA,
                        CANT_TOT: c.CANT_TOT
                    });
                }
            }
        };

        res2.forEach(procesar);
        res3.forEach(procesar);

        const arrayFinal = Array.from(clientesMap.values());
        
        // Replicar el comportamiento del ORDER BY NULLS FIRST, ASC en memoria
        arrayFinal.sort((a, b) => {
            const dateA = a.FECHA_ULTIMA_COMPRA ? new Date(a.FECHA_ULTIMA_COMPRA).getTime() : 0;
            const dateB = b.FECHA_ULTIMA_COMPRA ? new Date(b.FECHA_ULTIMA_COMPRA).getTime() : 0;
            
            // Nulls (ceros) van primero
            if (dateA === 0 && dateB !== 0) return -1;
            if (dateB === 0 && dateA !== 0) return 1;
            
            return dateA - dateB;
        });

        return arrayFinal;
    }
};

module.exports = {
    buscarClientePorRFC,
    obtenerVentasClientes,
    obtenerAniosVentas
};