const repo = require('../repositories/clientesRepository');

/**
 * Obtiene la información de un cliente dado su RFC
 */
const getClienteByRFC = async (req, res) => {
    try {
        const { rfc } = req.params;
        const { sucursal } = req.query; // Parámetro opcional: ?sucursal=3

        // Validación básica de entrada
        if (!rfc || rfc.trim().length < 9) {
            return res.status(400).json({ 
                error: "Petición inválida", 
                detalle: "El parámetro 'rfc' es obligatorio y debe tener un formato válido." 
            });
        }

        // Llamada al repositorio que maneja la lógica de BD y deduplicación
        const clientes = await repo.buscarClientePorRFC(rfc, sucursal);

        // Validamos si la base de datos no devolvió nada
        if (clientes.length === 0) {
            return res.status(404).json({ 
                error: "Cliente no encontrado", 
                detalle: `No se encontró ningún cliente registrado con el RFC: ${rfc.trim().toUpperCase()}` 
            });
        }

        // Respuesta estructurada
        res.json({
            total_encontrados: clientes.length,
            data: clientes
        });

    } catch (error) {
        console.error("Error en getClienteByRFC (Controller):", error.message);
        res.status(500).json({ 
            error: "Error interno del servidor", 
            detalle: error.message 
        });
    }
};

module.exports = {
    getClienteByRFC
};