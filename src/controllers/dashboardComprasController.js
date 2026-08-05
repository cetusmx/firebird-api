const repo = require('../repositories/dashboardComprasRepository');
const round2 = (num) => Math.round((num + Number.EPSILON) * 100) / 100;

const getAnalisisOrigenCompras = async (req, res) => {
    console.log(`\n-----------------------------------------`);
    console.log(`[CTRL-START] Petición recibida en /analisis-origen`);
    
    try {
        const { mes, anio, almacen, linea, perfil, genero, familia, page, limit } = req.query;

        const now = new Date();
        const fMes = parseInt(mes) || (now.getMonth() + 1);
        const fAnio = parseInt(anio) || now.getFullYear();
        
        const pPage = parseInt(page) || 1;
        const pLimit = parseInt(limit) || 50;
        const offset = (pPage - 1) * pLimit;

        const filtros = { mes: fMes, anio: fAnio, almacen, linea, perfil, genero, familia };

        console.log(`[CTRL] Solicitando datos al repositorio...`);
        const compras = await repo.obtenerComprasConsolidadas(filtros);
        console.log(`[CTRL] Datos recibidos en el controlador: ${compras.length}. Iniciando cálculo de métricas...`);

        let totalPartidas = 0;
        let partidasReposicion = 0;
        let partidasEspecial = 0;
        let montoTotal = 0;
        let montoReposicion = 0;
        let montoEspecial = 0;

        compras.forEach(row => {
            totalPartidas++;
            const cantidad = parseFloat(row.Cantidad) || 0;
            const costo = parseFloat(row.Costo) || 0;
            const montoPartida = cantidad * costo;
            montoTotal += montoPartida;

            const origenTexto = (row.Origen || "").toUpperCase();
            if (origenTexto.includes('REPOSICION') || origenTexto.includes('REPOSICIÓN')) {
                partidasReposicion++;
                montoReposicion += montoPartida;
            } else {
                partidasEspecial++;
                montoEspecial += montoPartida;
            }
        });

        console.log(`[CTRL] Paginando resultados (offset: ${offset}, limite: ${pLimit})...`);
        const datosPaginados = compras.slice(offset, offset + pLimit);

        console.log(`[CTRL-END] Enviando respuesta HTTP al cliente.`);
        res.json({
            periodo: { mes: fMes, anio: fAnio },
            filtros_aplicados: { almacen: almacen || null, linea: linea || null, perfil: perfil || null, genero: genero || null, familia: familia || null },
            metricas: {
                partidas: {
                    total: totalPartidas,
                    reposicion_cantidad: partidasReposicion,
                    reposicion_porcentaje: totalPartidas > 0 ? round2((partidasReposicion / totalPartidas) * 100) : 0,
                    pedido_especial_cantidad: partidasEspecial,
                    pedido_especial_porcentaje: totalPartidas > 0 ? round2((partidasEspecial / totalPartidas) * 100) : 0
                },
                montos: {
                    total: round2(montoTotal),
                    reposicion_monto: round2(montoReposicion),
                    reposicion_porcentaje: montoTotal > 0 ? round2((montoReposicion / montoTotal) * 100) : 0,
                    pedido_especial_monto: round2(montoEspecial),
                    pedido_especial_porcentaje: montoTotal > 0 ? round2((montoEspecial / montoTotal) * 100) : 0
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
        console.error("[CTRL-ERROR] Falla en getAnalisisOrigenCompras:", error);
        res.status(500).json({ error: "Error interno al analizar el origen de las compras", detalle: error.message });
    }
};

module.exports = { getAnalisisOrigenCompras };