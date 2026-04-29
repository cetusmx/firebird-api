const express = require('express');
const router = express.Router();
const db = require('../db'); // Usando la conexión de Empresa 2 (sufijo 02)

/**
 * Función auxiliar para resolver la clave de un producto
 * Basada en la lógica de prioridad: Catálogo -> Clave Alterna
 */
async function resolverClave(idProveedor, claveProveedor) {
    // 1. Intentar en Catálogo (INVE_CLIB02)
    // Regla: CAMPLIB15 si ID=35, CAMPLIB16 si ID=3
    let campoLibre = null;
    if (idProveedor === "35") campoLibre = "CAMPLIB15";
    else if (idProveedor === "3") campoLibre = "CAMPLIB16";

    if (campoLibre) {
        const sqlCat = `SELECT TRIM(CVE_PROD) as CLAVE_INTERNA FROM INVE_CLIB02 WHERE TRIM(${campoLibre}) = ?`;
        const resCat = await db.query(sqlCat, [claveProveedor]);
        if (resCat.length > 0 && resCat[0].CLAVE_INTERNA) {
            return { clave: resCat[0].CLAVE_INTERNA, origen: "Catálogo" };
        }
    }

    // 2. Si no se encontró, intentar en Claves Alternas (CVES_ALTER02)
    const sqlAlt = `SELECT TRIM(CVE_ART) as CLAVE_INTERNA FROM CVES_ALTER02 WHERE TRIM(CVE_CLPV) = ? AND TRIM(CVE_ALTER) = ?`;
    const resAlt = await db.query(sqlAlt, [idProveedor, claveProveedor]);
    if (resAlt.length > 0 && resAlt[0].CLAVE_INTERNA) {
        return { clave: resAlt[0].CLAVE_INTERNA, origen: "Clave alterna" };
    }

    // Si no se encontró en ninguna
    return { clave: null, origen: "No encontrado" };
}

/**
 * A. Consulta Masiva de Claves (POST)
 */
router.post('/getclavesprovee', async (req, res) => {
    const { rfc, claves } = req.body;

    if (!rfc || !Array.isArray(claves)) {
        return res.status(400).json({ error: "RFC y arreglo de claves son requeridos" });
    }

    try {
        // Obtener la CLAVE del proveedor por su RFC
        const sqlProv = `SELECT TRIM(CLAVE) as ID_PROV FROM PROV02 WHERE TRIM(RFC) = ?`;
        const resProv = await db.query(sqlProv, [rfc]);

        if (resProv.length === 0) {
            return res.status(404).json({ error: "Proveedor no encontrado con el RFC proporcionado" });
        }

        const idProv = resProv[0].ID_PROV;
        const resultados = [];

        // Resolver cada clave (Secuencial para evitar saturar el pool de conexiones)
        for (const cveProv of claves) {
            const resolucion = await resolverClave(idProv, cveProv);
            resultados.push({
                claveprove: cveProv,
                clave: resolucion.clave,
                origen: resolucion.origen
            });
        }

        res.json(resultados);

    } catch (error) {
        console.error("Error en búsqueda masiva:", error.message);
        res.status(500).json({ error: "Error interno del servidor", detalle: error.message });
    }
});

/**
 * B. Consulta Unitaria (GET)
 */
router.get('/getclavesproveedor', async (req, res) => {
    const { rfc, clave_proveedor } = req.query;

    if (!rfc || !clave_proveedor) {
        return res.status(400).json({ error: "rfc y clave_proveedor son requeridos" });
    }

    try {
        const sqlProv = `SELECT TRIM(CLAVE) as ID_PROV FROM PROV02 WHERE TRIM(RFC) = ?`;
        const resProv = await db.query(sqlProv, [rfc]);

        if (resProv.length === 0) {
            return res.status(404).json({ error: "Proveedor no encontrado" });
        }

        const idProv = resProv[0].ID_PROV;
        const resolucion = await resolverClave(idProv, clave_proveedor);

        res.json({
            claveprove: clave_proveedor,
            clave: resolucion.clave,
            origen: resolucion.origen
        });

    } catch (error) {
        console.error("Error en búsqueda unitaria:", error.message);
        res.status(500).json({ error: "Error interno del servidor", detalle: error.message });
    }
});

module.exports = router;