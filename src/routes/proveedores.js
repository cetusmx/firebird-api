const express = require('express');
const router = express.Router();
const db = require('../db'); 

/**
 * Función auxiliar para resolver la clave de un producto (Se mantiene igual)
 */
async function resolverClave(idProveedor, claveProveedor) {
    let campoLibre = null;
    if (idProveedor === "35") campoLibre = "CAMPLIB15";
    else if (idProveedor === "3") campoLibre = "CAMPLIB16";

    if (campoLibre) {
        const sqlCat = `
            SELECT TRIM(I.CVE_ART) as CLAVE_INTERNA 
            FROM INVE_CLIB02 C
            INNER JOIN INVE02 I ON I.CVE_ART = C.CVE_PROD
            WHERE TRIM(C.${campoLibre}) = ? 
              AND I.STATUS = 'A'`;
        
        const resCat = await db.query(sqlCat, [claveProveedor]);
        if (resCat.length > 0 && resCat[0].CLAVE_INTERNA) {
            return { clave: resCat[0].CLAVE_INTERNA, origen: "Catálogo" };
        }
    }

    const sqlAlt = `
        SELECT TRIM(I.CVE_ART) as CLAVE_INTERNA 
        FROM CVES_ALTER02 A
        INNER JOIN INVE02 I ON I.CVE_ART = A.CVE_ART
        WHERE A.CVE_CLPV = ? 
          AND TRIM(A.CVE_ALTER) = ? 
          AND I.STATUS = 'A'`;

    const resAlt = await db.query(sqlAlt, [idProveedor, claveProveedor]);
    if (resAlt.length > 0 && resAlt[0].CLAVE_INTERNA) {
        return { clave: resAlt[0].CLAVE_INTERNA, origen: "Clave alterna" };
    }

    return { clave: null, origen: "No encontrado" };
}

/**
 * A. Consulta Masiva de Claves (POST)
 * Nueva estructura: { cve_clpv: "...", partidas: [...] }
 */
router.post('/getclavesproveedor', async (req, res) => {
    const { rfc, claves } = req.body;

    if (!rfc || !claves || !Array.isArray(claves)) {
        return res.status(400).json({ 
            error: "Formato incorrecto", 
            detalle: "Se requiere 'rfc' y un arreglo 'claves'." 
        });
    }

    try {
        // Obtenemos la CLAVE interna del proveedor (cve_clpv)
        const sqlProv = `SELECT TRIM(CLAVE) as ID_PROV FROM PROV02 WHERE TRIM(RFC) = ?`;
        const resProv = await db.query(sqlProv, [rfc]);

        if (resProv.length === 0) {
            return res.status(404).json({ error: "Proveedor no encontrado" });
        }

        const idProv = resProv[0].ID_PROV;
        const partidas = [];

        // Procesamos cada clave de la lista
        for (const cveProv of claves) {
            const resolucion = await resolverClave(idProv, cveProv);
            partidas.push({
                claveprove: cveProv,
                clave: resolucion.clave,
                origen: resolucion.origen
            });
        }

        // Respuesta con la nueva estructura solicitada
        res.json({
            cve_clpv: idProv,
            partidas: partidas
        });

    } catch (error) {
        console.error("Error POST masivo:", error.message);
        res.status(500).json({ error: "Error interno", detalle: error.message });
    }
});

/**
 * B. Consulta Unitaria (GET) - Se mantiene igual
 */
router.get('/getclavesproveedor', async (req, res) => {
    const rfc = req.query.rfc;
    const clave_proveedor = req.query.clave_proveedor || req.query.clave;

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
        console.error("Error GET unitario:", error.message);
        res.status(500).json({ error: "Error interno", detalle: error.message });
    }
});

module.exports = router;