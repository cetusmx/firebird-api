const express = require('express');
const router = express.Router();
const db = require('../db'); // Conexión a Empresa 2 (sufijo 02)

/**
 * GET /api/almacenes
 * Retorna el catálogo de almacenes activos con formato para DropDownList.
 */
router.get('/almacenes', async (req, res) => {
    try {
        // Usamos alias (as) para mapear CVE_ALM a "id" y DESCR a "nombre"
        const sql = `
            SELECT 
                CVE_ALM as "id", 
                TRIM(DESCR) as "nombre" 
            FROM ALMACENES02 
            WHERE STATUS = 'A' 
            ORDER BY CVE_ALM ASC`;

        const almacenes = await db.query(sql);

        // Al usar alias en el SQL, el arreglo resultante ya viene con el formato deseado
        res.json(almacenes);

    } catch (error) {
        console.error("Error al obtener almacenes:", error.message);
        res.status(500).json({ 
            error: "Error al obtener el catálogo de almacenes", 
            detalle: error.message 
        });
    }
});

/**
 * GET /api/catalogos/jerarquia
 * Retorna las líneas y sus perfiles asociados filtrados por una familia específica (CAMPLIB24)
 * y opcionalmente acotado por su sistema de medición (CAMPLIB17).
 * * Ejemplo de llamada: /api/catalogos/jerarquia?familia=LIMPIADORES&sist_med=MM
 */
router.get('/jerarquia', async (req, res) => {
    const { familia, sist_med } = req.query;

    if (!familia) {
        return res.status(400).json({ 
            error: "Parámetro requerido", 
            detalle: "Debes proporcionar el parámetro 'familia' en la consulta." 
        });
    }

    const limpioFamilia = familia.trim().toUpperCase();

    // Consulta base uniendo inventario y campos libres apuntando a la familia activa (CAMPLIB24)
    let sql = `
        SELECT DISTINCT
            TRIM(I.LIN_PROD) as "LINEA",
            TRIM(C.CAMPLIB13) as "PERFIL"
        FROM INVE02 I
        INNER JOIN INVE_CLIB02 C ON I.CVE_ART = C.CVE_PROD
        WHERE I.STATUS = 'A'
          AND UPPER(TRIM(C.CAMPLIB24)) = CAST(? AS VARCHAR(100))
          AND I.LIN_PROD IS NOT NULL 
          AND TRIM(I.LIN_PROD) <> ''
          AND C.CAMPLIB13 IS NOT NULL 
          AND TRIM(C.CAMPLIB13) <> ''
    `;

    const params = [limpioFamilia];

    // CORRECCIÓN/MEJORA: Si se proporciona el sistema de medición, inyectamos el filtro de CAMPLIB17
    if (sist_med) {
        sql += ` AND UPPER(TRIM(C.CAMPLIB17)) = CAST(? AS VARCHAR(50)) `;
        params.push(sist_med.trim().toUpperCase());
    }

    // Cerramos el ordenamiento reglamentario
    sql += ` ORDER BY "LINEA" ASC, "PERFIL" ASC `;

    try {
        const rows = await db.query(sql, params);

        const lineasMap = {};

        rows.forEach(row => {
            const linea = row.LINEA;
            const perfil = row.PERFIL;

            if (!lineasMap[linea]) {
                lineasMap[linea] = [];
            }
            if (!lineasMap[linea].includes(perfil)) {
                lineasMap[linea].push(perfil);
            }
        });

        const resultadoJerarquia = Object.entries(lineasMap).map(([linea, perfiles]) => ({
            linea,
            perfiles
        }));

        res.json(resultadoJerarquia);

    } catch (error) {
        console.error("Error al obtener la jerarquía de catálogos:", error.message);
        res.status(500).json({
            error: "Error interno del servidor al procesar la jerarquía",
            detalle: error.message
        });
    }
});

/**
 * GET /api/catalogos/sugerencias
 * Endpoint inteligente de autocompletado para dimensiones de productos.
 * Realiza un filtrado cruzado auto-excluyente para sugerir medidas reales existentes.
 */
router.get('/sugerencias', async (req, res) => {
    const { familia, sist_med, perfiles, diam_int, diam_ext, altura, seccion } = req.query;

    // 1. Validaciones obligatorias de la Etapa 3
    if (!familia || !sist_med) {
        return res.status(400).json({
            error: "Parámetros requeridos",
            detalle: "Se requiere obligatoriamente 'familia' y 'sist_med' para calcular las sugerencias."
        });
    }

    const limpioFamilia = familia.trim().toUpperCase();
    const limpioSistMed = sist_med.trim().toUpperCase();

    // 2. Construcción de consulta base acotada por catálogo y sistema de medición
    let sql = `
        SELECT 
            TRIM(C.CAMPLIB1) as "DI",
            TRIM(C.CAMPLIB2) as "DE",
            TRIM(C.CAMPLIB3) as "ALT",
            TRIM(C.CAMPLIB7) as "SEC"
        FROM INVE02 I
        INNER JOIN INVE_CLIB02 C ON I.CVE_ART = C.CVE_PROD
        WHERE I.STATUS = 'A'
          AND UPPER(TRIM(C.CAMPLIB24)) = CAST(? AS VARCHAR(100))
          AND UPPER(TRIM(C.CAMPLIB17)) = CAST(? AS VARCHAR(50))
    `;
    const params = [limpioFamilia, limpioSistMed];

    // Si se envían perfiles específicos (separados por comas) los acotamos en el SQL
    if (perfiles) {
        const arrPerfiles = perfiles.split(',').map(p => p.trim().toUpperCase()).filter(p => p !== '');
        if (arrPerfiles.length > 0) {
            const placeholders = arrPerfiles.map(() => '?').join(',');
            sql += ` AND UPPER(TRIM(C.CAMPLIB13)) IN (${placeholders}) `;
            params.push(...arrPerfiles);
        }
    }

    try {
        const rows = await db.query(sql, params);

        // 3. Normalización y limpieza de los datos crudos de Firebird en memoria
        const registrosDimensiones = rows.map(r => {
            const parseDim = (val) => {
                if (!val) return null;
                const normalized = val.replace(',', '.'); // Compatibilidad total con comas decimales
                const num = parseFloat(normalized);
                return isNaN(num) ? null : num;
            };
            return {
                di: parseDim(r.DI),
                de: parseDim(r.DE),
                alt: parseDim(r.ALT),
                sec: parseDim(r.SEC)
            };
        }).filter(r => r.di !== null || r.de !== null || r.alt !== null || r.sec !== null);
        
        // 4. Parsear inputs actuales enviados por el usuario desde el frontend
        const targetDi = diam_int ? parseFloat(String(diam_int).replace(',', '.')) : null;
        const targetDe = diam_ext ? parseFloat(String(diam_ext).replace(',', '.')) : null;
        const targetAlt = altura ? parseFloat(String(altura).replace(',', '.')) : null;
        const targetSec = seccion ? parseFloat(String(seccion).replace(',', '.')) : null;

        // Función auxiliar para comparar flotantes con un margen de tolerancia (Epsilon)
        const cumpleFiltro = (valorConstante, valorFiltroTarget) => {
            if (valorFiltroTarget === null || isNaN(valorFiltroTarget)) return true; // Filtro inactivo
            if (valorConstante === null) return false;
            return Math.abs(valorConstante - valorFiltroTarget) < 0.001; // Match decimal preciso
        };

        // Estructuras Set para garantizar unicidad de opciones automáticamente
        const setDi = new Set();
        const setDe = new Set();
        const setAlt = new Set();
        const setSec = new Set();

        // 5. Magia del Filtrado Cruzado Auto-Excluyente
        registrosDimensiones.forEach(row => {
            // opciones_di: Aplica filtros de DE, Altura y Sección (Ignora su propio input diam_int)
            if (cumpleFiltro(row.de, targetDe) && cumpleFiltro(row.alt, targetAlt) && cumpleFiltro(row.sec, targetSec)) {
                if (row.di !== null) setDi.add(row.di);
            }

            // opciones_de: Aplica filtros de DI, Altura y Sección (Ignora su propio input diam_ext)
            if (cumpleFiltro(row.di, targetDi) && cumpleFiltro(row.alt, targetAlt) && cumpleFiltro(row.sec, targetSec)) {
                if (row.de !== null) setDe.add(row.de);
            }

            // opciones_altura: Aplica filtros de DI, DE y Sección (Ignora su propio input altura)
            if (cumpleFiltro(row.di, targetDi) && cumpleFiltro(row.de, targetDe) && cumpleFiltro(row.sec, targetSec)) {
                if (row.alt !== null) setAlt.add(row.alt);
            }

            // opciones_seccion: Aplica filtros de DI, DE y Altura (Ignora su propio input seccion)
            if (cumpleFiltro(row.di, targetDi) && cumpleFiltro(row.de, targetDe) && cumpleFiltro(row.alt, targetAlt)) {
                if (row.sec !== null) setSec.add(row.sec);
            }
        });

        // 6. Conversión a arrays limpios ordenados numéricamente de menor a mayor
        const ordenarAscendente = (a, b) => a - b;

        res.json({
            opciones_di: Array.from(setDi).sort(ordenarAscendente),
            opciones_de: Array.from(setDe).sort(ordenarAscendente),
            opciones_altura: Array.from(setAlt).sort(ordenarAscendente),
            opciones_seccion: Array.from(setSec).sort(ordenarAscendente)
        });

    } catch (error) {
        console.error("Error en endpoint de sugerencias inteligentes:", error.message);
        res.status(500).json({
            error: "Error interno del servidor al procesar el catálogo de sugerencias",
            detalle: error.message
        });
    }
});

/**
 * GET /api/catalogos/sugerencias-v2
 * Endpoint inteligente de autocompletado cruzado V2.
 * Añade soporte para perfiles y líneas, manteniendo la exclusión inteligente de opciones.
 */
router.get('/sugerencias-v2', async (req, res) => {
    const { familia, sist_med, perfiles, diam_int, diam_ext, altura, seccion } = req.query;

    if (!familia || !sist_med) {
        return res.status(400).json({
            error: "Parámetros requeridos",
            detalle: "Se requiere obligatoriamente 'familia' y 'sist_med'."
        });
    }

    const limpioFamilia = familia.trim().toUpperCase();
    const limpioSistMed = sist_med.trim().toUpperCase();

    // 1. Consulta base: Extraemos todo el universo de esa familia y sistema
    // No filtramos por 'perfiles' en SQL para permitir que Node haga la sugerencia cruzada de perfiles alternativos.
    const sql = `
        SELECT 
            TRIM(C.CAMPLIB1) as "DI",
            TRIM(C.CAMPLIB2) as "DE",
            TRIM(C.CAMPLIB3) as "ALT",
            TRIM(C.CAMPLIB7) as "SEC",
            TRIM(C.CAMPLIB13) as "PERFIL",
            TRIM(I.LIN_PROD) as "LINEA"
        FROM INVE02 I
        INNER JOIN INVE_CLIB02 C ON I.CVE_ART = C.CVE_PROD
        WHERE I.STATUS = 'A'
          AND UPPER(TRIM(C.CAMPLIB24)) = CAST(? AS VARCHAR(100))
          AND UPPER(TRIM(C.CAMPLIB17)) = CAST(? AS VARCHAR(50))
    `;

    try {
        const rows = await db.query(sql, [limpioFamilia, limpioSistMed]); //

        // 2. Normalización de datos numéricos y de texto en memoria
        const parseDim = (val) => {
            if (!val) return null;
            const num = parseFloat(val.replace(',', '.')); // Soporte nativo para comas decimales SAE
            return isNaN(num) ? null : num;
        };

        const registros = rows.map(r => ({
            di: parseDim(r.DI),
            de: parseDim(r.DE),
            alt: parseDim(r.ALT),
            sec: parseDim(r.SEC),
            perfil: r.PERFIL ? r.PERFIL.trim().toUpperCase() : null,
            linea: r.LINEA ? r.LINEA.trim().toUpperCase() : null
        }));

        // 3. Parsear inputs actuales enviados por el usuario
        const targetDi = diam_int ? parseFloat(String(diam_int).replace(',', '.')) : null;
        const targetDe = diam_ext ? parseFloat(String(diam_ext).replace(',', '.')) : null;
        const targetAlt = altura ? parseFloat(String(altura).replace(',', '.')) : null;
        const targetSec = seccion ? parseFloat(String(seccion).replace(',', '.')) : null;
        
        const targetPerfiles = perfiles 
            ? perfiles.split(',').map(p => p.trim().toUpperCase()).filter(p => p !== '') 
            : null;

        // Funciones booleanas de validación
        const cumpleDim = (valRow, valTarget) => {
            if (valTarget === null || isNaN(valTarget)) return true; // Sin filtro activo
            if (valRow === null) return false;
            return Math.abs(valRow - valTarget) < 0.001; // Tolerancia de error de coma flotante
        };

        const cumplePerfil = (valRow, arrTarget) => {
            if (!arrTarget || arrTarget.length === 0) return true; // Sin filtro activo
            if (!valRow) return false;
            return arrTarget.includes(valRow);
        };

        // 4. Sets para garantizar valores únicos automáticamente
        const setDi = new Set();
        const setDe = new Set();
        const setAlt = new Set();
        const setSec = new Set();
        const setPerfiles = new Set();
        const setLineas = new Set();

        // 5. Magia del Filtrado Cruzado Auto-Excluyente
        registros.forEach(row => {
            const matchDi = cumpleDim(row.di, targetDi);
            const matchDe = cumpleDim(row.de, targetDe);
            const matchAlt = cumpleDim(row.alt, targetAlt);
            const matchSec = cumpleDim(row.sec, targetSec);
            const matchPerf = cumplePerfil(row.perfil, targetPerfiles);

            // Cada set requiere que todos los DEMÁS filtros coincidan
            if (matchDe && matchAlt && matchSec && matchPerf && row.di !== null) setDi.add(row.di);
            
            if (matchDi && matchAlt && matchSec && matchPerf && row.de !== null) setDe.add(row.de);
            
            if (matchDi && matchDe && matchSec && matchPerf && row.alt !== null) setAlt.add(row.alt);
            
            if (matchDi && matchDe && matchAlt && matchPerf && row.sec !== null) setSec.add(row.sec);
            
            if (matchDi && matchDe && matchAlt && matchSec && row.perfil !== null) setPerfiles.add(row.perfil);
            
            // La línea no es un input filtrable de esta etapa, por ende exige coincidencia absoluta de todos
            if (matchDi && matchDe && matchAlt && matchSec && matchPerf && row.linea !== null) setLineas.add(row.linea);
        });

        // 6. Ordenamiento y Respuesta
        const ordenarNum = (a, b) => a - b;
        const ordenarStr = (a, b) => a.localeCompare(b);

        res.json({
            opciones_di: Array.from(setDi).sort(ordenarNum),
            opciones_de: Array.from(setDe).sort(ordenarNum),
            opciones_altura: Array.from(setAlt).sort(ordenarNum),
            opciones_seccion: Array.from(setSec).sort(ordenarNum),
            opciones_perfiles: Array.from(setPerfiles).sort(ordenarStr),
            opciones_lineas: Array.from(setLineas).sort(ordenarStr)
        });

    } catch (error) {
        console.error("Error en /sugerencias-v2:", error.message);
        res.status(500).json({
            error: "Error interno del servidor",
            detalle: error.message
        });
    }
});

module.exports = router;