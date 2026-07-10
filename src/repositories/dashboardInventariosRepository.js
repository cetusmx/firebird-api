const db = require('../db'); // Conexión a Empresa 2

/**
 * Consulta a Firebird los movimientos de inventario (MINVE02) y catálogos (INVE_CLIB02)
 * dividiendo las claves en bloques para respetar los límites de la base de datos.
 */
const obtenerMovimientosYClasificacion = async (refer, productos) => {
    const dbResults = [];
    const chunkSize = 200; // Reducido para evitar error -204 de Firebird
    
    // Limpieza de espacios para evitar fallos de strings binarios en Firebird
    const cleanedClaves = productos.map(p => String(p).trim());

    for (let i = 0; i < cleanedClaves.length; i += chunkSize) {
        const chunk = cleanedClaves.slice(i, i + chunkSize);
        const placeholders = chunk.map(() => '?').join(',');

        // TRIM() en el JOIN y en el WHERE para que Firebird pueda emparejar las claves correctamente
        const sql = `
            SELECT 
                TRIM(C.CVE_PROD) as "CVE_ART",
                TRIM(M.REFER) as "REFER",
                M.CVE_CPTO as "CVE_CPTO",
                M.COSTO as "COSTO",
                M.CANT as "CANT",
                TRIM(C.CAMPLIB22) as "FAMILIA",
                TRIM(C.CAMPLIB21) as "GENERO",
                TRIM(C.CAMPLIB24) as "CATEGORIA"
            FROM INVE_CLIB02 C
            LEFT JOIN MINVE02 M ON TRIM(M.CVE_ART) = TRIM(C.CVE_PROD) 
                                AND TRIM(M.REFER) = ? 
                                AND M.CVE_CPTO IN (10, 60)
            WHERE TRIM(C.CVE_PROD) IN (${placeholders})
        `;
        
        const queryParams = [refer.trim(), ...chunk];
        const chunkRes = await db.query(sql, queryParams);
        dbResults.push(...chunkRes);
    }
    //console.log("Resultados: ", dbResults);

    return dbResults;
};

/**
 * Consulta a Firebird los movimientos de inventario (MINVE02) y catálogos (INVE_CLIB02)
 * dividiendo las claves en bloques para respetar los límites de la base de datos.
 */
/* const obtenerMovimientosYClasificacion = async (refer, productos) => {
    const dbResults = [];
    const chunkSize = 200; // Reducido para evitar error -204 y tener más visibilidad
    
    // Limpieza de espacios para evitar fallos de strings binarios en Firebird
    const cleanedClaves = productos.map(p => String(p).trim());
    
    console.log('🔍 INICIANDO CONSULTA DE MOVIMIENTOS');
    console.log('   Total de productos a consultar:', cleanedClaves.length);
    console.log('   REFER:', refer);
    console.log('   Chunk size:', chunkSize);
    console.log('   Total de chunks estimados:', Math.ceil(cleanedClaves.length / chunkSize));

    for (let i = 0; i < cleanedClaves.length; i += chunkSize) {
        const chunkIndex = Math.floor(i / chunkSize) + 1;
        const chunk = cleanedClaves.slice(i, i + chunkSize);
        const placeholders = chunk.map(() => '?').join(',');
        
        console.log(`\n📦 PROCESANDO CHUNK ${chunkIndex}/${Math.ceil(cleanedClaves.length / chunkSize)}`);
        console.log('   Productos en este chunk:', chunk.length);
        console.log('   Primeros 3 productos:', chunk.slice(0, 3));
        console.log('   Últimos 3 productos:', chunk.slice(-3));

        // 🔧 CORRECCIÓN: Agregamos TRIM() en el JOIN y en el WHERE
        const sql = `
            SELECT 
                TRIM(C.CVE_PROD) as "CVE_ART",
                TRIM(M.REFER) as "REFER",
                M.CVE_CPTO as "CVE_CPTO",
                M.COSTO as "COSTO",
                M.CANT as "CANT",
                TRIM(C.CAMPLIB22) as "FAMILIA",
                TRIM(C.CAMPLIB21) as "GENERO",
                TRIM(C.CAMPLIB24) as "CATEGORIA"
            FROM INVE_CLIB02 C
            LEFT JOIN MINVE02 M ON TRIM(M.CVE_ART) = TRIM(C.CVE_PROD) 
                                AND TRIM(M.REFER) = ? 
                                AND M.CVE_CPTO IN (10, 60)
            WHERE TRIM(C.CVE_PROD) IN (${placeholders})
        `;
        
        const queryParams = [refer.trim(), ...chunk];
        
        try {
            console.log('   ⏳ Ejecutando consulta...');
            const chunkStartTime = Date.now();
            const chunkRes = await db.query(sql, queryParams);
            const chunkEndTime = Date.now();
            
            console.log('   ✅ Chunk completado en', (chunkEndTime - chunkStartTime), 'ms');
            console.log('   📊 Registros encontrados en este chunk:', chunkRes.length);
            
            if (chunkRes.length > 0) {
                console.log('   📋 Primer registro encontrado:', JSON.stringify(chunkRes[0], null, 2));
                console.log('    Último registro encontrado:', JSON.stringify(chunkRes[chunkRes.length - 1], null, 2));
            } else {
                console.log('   ️  NO se encontraron registros en este chunk');
                console.log('   🔍 Primeras 5 claves del chunk para verificar:');
                chunk.slice(0, 5).forEach((clave, idx) => {
                    console.log(`      ${idx + 1}. "${clave}"`);
                });
            }
            
            dbResults.push(...chunkRes);
        } catch (error) {
            console.error('   ❌ ERROR en chunk', chunkIndex, ':', error.message);
            console.error('   SQL:', sql.substring(0, 200) + '...');
            console.error('   Query params length:', queryParams.length);
        }
    }

    console.log('\n🏁 CONSULTA FINALIZADA');
    console.log('   Total de registros obtenidos:', dbResults.length);
    console.log('   Total de productos únicos consultados:', cleanedClaves.length);
    
    if (dbResults.length > 0) {
        const productosConMovimientos = [...new Set(dbResults.map(r => r.CVE_ART))];
        console.log('   Productos con movimientos encontrados:', productosConMovimientos.length);
        console.log('   Productos SIN movimientos:', cleanedClaves.length - productosConMovimientos.length);
    }

    return dbResults;
}; */

module.exports = {
    obtenerMovimientosYClasificacion
};