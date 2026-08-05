const repo = require('../repositories/dashboardComprasRepository');

// Función de redondeo estándar a 2 decimales
const round2 = (num) => Math.round((num + Number.EPSILON) * 100) / 100;

/**
 * Controlador para analizar el origen de las compras (Reposición vs Pedido Especial)
 * Calcula métricas sobre el total filtrado y pagina los resultados de detalle.
 */
const getAnalisisOrigenCompras = async (req, res) => {
    try {
        // Extraer parámetros de la URL
        const { 
            mes, anio, almacen, 
            linea, perfil, genero, familia, 
            page, limit 
        } = req.query;

        // Valores por defecto para fechas si no se envían
        const now = new Date();
        const fMes = parseInt(mes) || (now.getMonth() + 1);
        const fAnio = parseInt(anio) || now.getFullYear();
        
        // Configuración de Paginación
        const pPage = parseInt(page) || 1;
        const pLimit = parseInt(limit) || 50;
        const offset = (pPage - 1) * pLimit;

        // Filtros que se enviarán al repositorio
        const filtros = { 
            mes: fMes, 
            anio: fAnio, 
            almacen, 
            linea, 
            perfil, 
            genero, 
            familia 
        };

        // 1. Obtener TODA la data cruda del mes (Ambas empresas) desde el repositorio
        const compras = await repo.obtenerComprasConsolidadas(filtros);

        // 2. Inicializar variables para las métricas
        let totalPartidas = 0;
        let partidasReposicion = 0;
        let partidasEspecial = 0;
        
        let montoTotal = 0;
        let montoReposicion = 0;
        let montoEspecial = 0;

        // 3. Iterar sobre todos los registros para calcular los totales reales
        compras.forEach(row => {
            totalPartidas++;
            
            // Calculamos el monto de la partida real (Cantidad ingresada * Costo unitario)
            const cantidad = parseFloat(row.Cantidad) || 0;
            const costo = parseFloat(row.Costo) || 0;
            const montoPartida = cantidad * costo;
            
            montoTotal += montoPartida;

            // Lógica de distinción: Buscamos "REPOSICION" o "REPOSICIÓN" en el campo Origen
            const origenTexto = (row.Origen || "").toUpperCase();
            const esReposicion = origenTexto.includes('REPOSICION') || origenTexto.includes('REPOSICIÓN');

            if (esReposicion) {
                partidasReposicion++;
                montoReposicion += montoPartida;
            } else {
                partidasEspecial++;
                montoEspecial += montoPartida;
            }
        });

        // 4. Calcular Porcentajes (evitando división por cero)
        const porcPartidasRep = totalPartidas > 0 ? round2((partidasReposicion / totalPartidas) * 100) : 0;
        const porcPartidasEsp = totalPartidas > 0 ? round2((partidasEspecial / totalPartidas) * 100) : 0;
        
        const porcMontoRep = montoTotal > 0 ? round2((montoReposicion / montoTotal) * 100) : 0;
        const porcMontoEsp = montoTotal > 0 ? round2((montoEspecial / montoTotal) * 100) : 0;

        // 5. Paginar los datos en memoria para la tabla de detalles del Frontend
        const datosPaginados = compras.slice(offset, offset + pLimit);

        // 6. Enviar Respuesta JSON Estructurada
        res.json({
            periodo: { 
                mes: fMes, 
                anio: fAnio 
            },
            filtros_aplicados: { 
                almacen: almacen || null, 
                linea: linea || null, 
                perfil: perfil || null, 
                genero: genero || null, 
                familia: familia || null 
            },
            metricas: {
                partidas: {
                    total: totalPartidas,
                    reposicion_cantidad: partidasReposicion,
                    reposicion_porcentaje: porcPartidasRep,
                    pedido_especial_cantidad: partidasEspecial,
                    pedido_especial_porcentaje: porcPartidasEsp
                },
                montos: {
                    total: round2(montoTotal),
                    reposicion_monto: round2(montoReposicion),
                    reposicion_porcentaje: porcMontoRep,
                    pedido_especial_monto: round2(montoEspecial),
                    pedido_especial_porcentaje: porcMontoEsp
                }
            },
            paginacion: {
                total_registros: totalPartidas,
                pagina_actual: pPage,
                limite: pLimit,
                total_paginas: Math.ceil(totalPartidas / pLimit)
            },
            data: datosPaginados
        });

    } catch (error) {
        console.error("Error en getAnalisisOrigenCompras:", error.message);
        res.status(500).json({ 
            error: "Error interno al analizar el origen de las compras", 
            detalle: error.message 
        });
    }
};

module.exports = {
    getAnalisisOrigenCompras
};