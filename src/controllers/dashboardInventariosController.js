const repo = require('../repositories/dashboardInventariosRepository');

/**
 * Maneja la petición HTTP para calcular la asertividad del inventario cíclico
 * SOPORTA: Múltiples movimientos de corrección por producto (Neteo de mercancía)
 */
const getAsertividadCiclico = async (req, res) => {
    try {
        const { refer, productos } = req.body;

        if (!refer || !productos || !Array.isArray(productos)) {
            return res.status(400).json({ 
                error: "Los parámetros 'refer' (string) y 'productos' (array de strings) son obligatorios." 
            });
        }

        if (productos.length === 0) {
            return res.json([]);
        }

        const cleanedClaves = productos.map(p => String(p).trim());
        const datosBD = await repo.obtenerMovimientosYClasificacion(refer, cleanedClaves);

        // Procesamos producto por producto asegurando consolidación
        const respuestaFinal = cleanedClaves.map(clave => {
            
            // 1. Filtramos TODOS los movimientos que tuvo ESTE producto en específico
            const movimientosProducto = datosBD.filter(r => r.CVE_ART === clave && r.REFER);

            // ESCENARIO A: El producto no tiene ningún movimiento asignado
            if (movimientosProducto.length === 0) {
                const cat = datosBD.find(r => r.CVE_ART === clave);
                return {
                    CVE_ART: clave,
                    REFER: "",
                    CVE_CPTO: null,
                    COSTO: null,
                    CANT: null,
                    FAMILIA: cat ? (cat.FAMILIA || "") : "",
                    GENERO: cat ? (cat.GENERO || "") : "",
                    CATEGORIA: cat ? (cat.CATEGORIA || "") : "",
                    RESULTADO: "SIN CAMBIO"
                };
            }

            // ESCENARIO B: Hay 1 o más movimientos. Vamos a consolidar (Netear)
            const primerRegistro = movimientosProducto[0];
            let totalAjuste = 0;
            let totalMerma = 0;

            movimientosProducto.forEach(mov => {
                const cpto = parseInt(mov.CVE_CPTO, 10);
                const cant = parseFloat(mov.CANT) || 0;
                
                if (cpto === 10) totalAjuste += cant;
                if (cpto === 60) totalMerma += cant;
            });

            // Reglas de negocio para el Neteo
            let resultadoTxt = "SIN CAMBIO";
            let cveCptoFinal = null;
            let cantidadFinal = 0;

            if (totalAjuste === totalMerma) {
                // Se cancelaron mutuamente (Ej: Merma de 5 y luego Ajuste de 5 para corregir)
                resultadoTxt = "SIN CAMBIO";
                cveCptoFinal = null;
                cantidadFinal = 0;
            } else if (totalAjuste > totalMerma) {
                // El ajuste fue mayor
                resultadoTxt = "AJUSTE";
                cveCptoFinal = 10;
                cantidadFinal = totalAjuste - totalMerma;
            } else {
                // La merma fue mayor
                resultadoTxt = "MERMA";
                cveCptoFinal = 60;
                cantidadFinal = totalMerma - totalAjuste;
            }

            return {
                CVE_ART: clave,
                REFER: refer.trim(),
                CVE_CPTO: cveCptoFinal,
                COSTO: primerRegistro.COSTO,
                CANT: cantidadFinal,
                FAMILIA: primerRegistro.FAMILIA || "",
                GENERO: primerRegistro.GENERO || "",
                CATEGORIA: primerRegistro.CATEGORIA || "",
                RESULTADO: resultadoTxt
            };
        });

        return res.json(respuestaFinal);

    } catch (error) {
        console.error("Error en getAsertividadCiclico (Controller):", error.message);
        return res.status(500).json({ error: "Error interno del servidor", detalle: error.message });
    }
};

module.exports = {
    getAsertividadCiclico
};