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
    const isGlobal = !almacen || almacen === '0' || almacen === 'null' || almacen === 'undefined' || almacen === 'todos';
    
    // Preparar parámetros para subconsultas de facturas
    let filtroFacturas = '';
    const params2 = [];
    const params3 = [];

    if (!isGlobal) {
        filtroFacturas = ` AND F.NUM_ALMA = ? `;
        // Parámetro inyectado 3 veces para las 3 subconsultas (NUM_ALMA, FECHA_DOC, CAN_TOT)
        params2.push(almacen, almacen, almacen);
        params3.push(almacen, almacen, almacen);
    }

    // 1. Extraemos los campos base Y las subconsultas de su respectiva tabla FACTF
    const getCamposClie = (tablaFact) => `
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
    `;

    let sql2 = `SELECT ${getCamposClie('FACTF02')} FROM CLIE02 C WHERE C.STATUS = 'A'`;
    let sql3 = `SELECT ${getCamposClie('FACTF03')} FROM CLIE03 C WHERE C.STATUS = 'A'`;

    // Filtro exacto de cliente
    if (cliente) {
        sql2 += ` AND UPPER(TRIM(C.CLAVE)) = UPPER(TRIM(?))`;
        sql3 += ` AND UPPER(TRIM(C.CLAVE)) = UPPER(TRIM(?))`;
        params2.push(cliente);
        params3.push(cliente);
    }

    // Leemos ambas tablas a memoria (traen ya la información de la última factura local de cada BD)
    const [list02, list03] = await Promise.all([
        db.query(sql2, params2),
        db3.query(sql3, params3)
    ]);

    const clie03Map = new Map();
    for (const c3 of list03) {
        clie03Map.set(c3.CLAVE, c3);
    }

    const unified = [];
    const clie02MapByRFC = new Map();

    // -----------------------------------------------------------
    // REGLA A: Barrer CLIE02 (Tabla Base)
    // -----------------------------------------------------------
    for (const c2 of list02) {
        c2.CONDICION = ""; 
        const clave2 = c2.CLAVE;
        const rfc2 = c2.RFC || '';

        if (clie03Map.has(clave2)) {
            const c3 = clie03Map.get(clave2);
            const rfc3 = c3.RFC || '';
            
            if (rfc2 === rfc3) {
                c2.CONDICION = "Duplicado";
                
                // PASO 3: Comparar registros de FACTF02 y FACTF03 y conservar el más reciente
                const d2 = c2.FECHA_ULTIMA_COMPRA ? new Date(c2.FECHA_ULTIMA_COMPRA).getTime() : 0;
                const d3 = c3.FECHA_ULTIMA_COMPRA ? new Date(c3.FECHA_ULTIMA_COMPRA).getTime() : 0;
                
                if (d3 > d2) {
                    c2.FECHA_ULTIMA_COMPRA = c3.FECHA_ULTIMA_COMPRA;
                    c2.NUM_ALMA = c3.NUM_ALMA;
                    c2.CANT_TOT = c3.CANT_TOT;
                }

                clie03Map.delete(clave2);
            }
        }
        
        unified.push(c2);
        if (rfc2) {
            clie02MapByRFC.set(rfc2, c2);
        }
    }

    // -----------------------------------------------------------
    // REGLA B: Evaluar remanentes en CLIE03
    // -----------------------------------------------------------
    for (const [clave3, c3] of clie03Map.entries()) {
        const rfc3 = c3.RFC || '';
        
        if (rfc3 && clie02MapByRFC.has(rfc3)) {
            const c2Ref = clie02MapByRFC.get(rfc3);
            c2Ref.CONDICION = "Duplicado con clave diferente";
            
            // PASO 3 aplicado a remanentes: Comparar compras y actualizar C2 si la compra en C3 es más reciente
            const d2 = c2Ref.FECHA_ULTIMA_COMPRA ? new Date(c2Ref.FECHA_ULTIMA_COMPRA).getTime() : 0;
            const d3 = c3.FECHA_ULTIMA_COMPRA ? new Date(c3.FECHA_ULTIMA_COMPRA).getTime() : 0;
            
            if (d3 > d2) {
                c2Ref.FECHA_ULTIMA_COMPRA = c3.FECHA_ULTIMA_COMPRA;
                c2Ref.NUM_ALMA = c3.NUM_ALMA;
                c2Ref.CANT_TOT = c3.CANT_TOT;
            }
        } else {
            c3.CONDICION = "Solo existe en CLIE03";
            unified.push(c3);
        }
    }

    // -----------------------------------------------------------
    // APLICAR FILTROS (Almacén, Año) Y ORDENAMIENTO EN MEMORIA
    // -----------------------------------------------------------
    let arrayFinal = unified;

    if (anio && anio !== 'null' && anio !== 'sin_compras' && anio !== 'undefined') {
        const yearInt = parseInt(anio, 10);
        arrayFinal = arrayFinal.filter(c => {
            if (!c.FECHA_ULTIMA_COMPRA) return false;
            return new Date(c.FECHA_ULTIMA_COMPRA).getFullYear() === yearInt;
        });
    } else if (anio === 'null' || anio === 'sin_compras') {
        arrayFinal = arrayFinal.filter(c => !c.FECHA_ULTIMA_COMPRA);
    } else if (!isGlobal) {
        // Al filtrar por almacén específico ocultamos clientes que no tienen compras en él
        arrayFinal = arrayFinal.filter(c => c.FECHA_ULTIMA_COMPRA != null);
    }

    // Ordenamiento: NULLS FIRST, luego fechas antiguas primero
    arrayFinal.sort((a, b) => {
        const dateA = a.FECHA_ULTIMA_COMPRA ? new Date(a.FECHA_ULTIMA_COMPRA).getTime() : 0;
        const dateB = b.FECHA_ULTIMA_COMPRA ? new Date(b.FECHA_ULTIMA_COMPRA).getTime() : 0;
        
        if (dateA === 0 && dateB !== 0) return -1;
        if (dateB === 0 && dateA !== 0) return 1;
        
        return dateA - dateB;
    });

    return arrayFinal;
};

module.exports = {
    buscarClientePorRFC,
    obtenerVentasClientes,
    obtenerAniosVentas
};