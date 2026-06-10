const repo = require('../repositories/dashboardInventariosRepository');

/**
 * Maneja la petición HTTP para calcular la asertividad del inventario cíclico
 */
const getAsertividadCiclico = async (req, res) => {
    try {
        const { refer, productos } = req.body;

        // 1. Validaciones HTTP de entrada
        if (!refer || !productos || !Array.isArray(productos)) {
            return res.status(400).json({ 
                error: "Los parámetros 'refer' (string) y 'productos' (array de strings) son obligatorios." 
            });
        }

        if (productos.length === 0) {
            return res.json([]);
        }

        const cleanedClaves = productos.map(p => String(p).trim());

        // 2. Solicitar datos crudos al repositorio
        const datosBD = await repo.obtenerMovimientosYClasificacion(refer, cleanedClaves);

        // 3. Aplicar Reglas de Negocio (Mapear el resultado final de cada producto)
        const respuestaFinal = cleanedClaves.map(clave => {
            const registro = datosBD.find(r => r.CVE_ART === clave);

            // Si se localizó el registro y tiene un REFER asociado, hubo movimiento destructivo/correctivo
            if (registro && registro.REFER) {
                let resultadoTxt = "SIN CAMBIO";
                const cpto = parseInt(registro.CVE_CPTO, 10);
                
                if (cpto === 10) resultadoTxt = "AJUSTE";
                if (cpto === 60) resultadoTxt = "MERMA";

                return {
                    CVE_ART: registro.CVE_ART,
                    REFER: registro.REFER,
                    CVE_CPTO: registro.CVE_CPTO,
                    COSTO: registro.COSTO,
                    CANT: registro.CANT,
                    FAMILIA: registro.FAMILIA || "",
                    GENERO: registro.GENERO || "",
                    CATEGORIA: registro.CATEGORIA || "",
                    RESULTADO: resultadoTxt
                };
            } else {
                // Si el producto no tuvo movimientos generados por el administrador (O no existe en catálogo)
                return {
                    CVE_ART: clave,
                    REFER: "",
                    CVE_CPTO: null,
                    COSTO: null,
                    CANT: null,
                    FAMILIA: registro ? (registro.FAMILIA || "") : "",
                    GENERO: registro ? (registro.GENERO || "") : "",
                    CATEGORIA: registro ? (registro.CATEGORIA || "") : "",
                    RESULTADO: "SIN CAMBIO"
                };
            }
        });

        // 4. Enviar respuesta exitosa
        return res.json(respuestaFinal);

    } catch (error) {
        console.error("Error en getAsertividadCiclico (Controller):", error.message);
        return res.status(500).json({ error: "Error interno del servidor", detalle: error.message });
    }
};

module.exports = {
    getAsertividadCiclico
};