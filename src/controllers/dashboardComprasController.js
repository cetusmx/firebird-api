const repo = require('../repositories/dashboardComprasRepository');

// Función auxiliar de redondeo estándar a 2 decimales
const round2 = (num) => Math.round((num + Number.EPSILON) * 100) / 100;

// Función para parsear parámetros separados por comas a arreglos limpios (Soporte Múltiple)
const parseQueryArray = (param) => {
    if (!param) return null;
    const str = Array.isArray(param) ? param.join(',') : String(param);
    const arr = str.split(',').map(s => s.replace(/['"]/g, '').trim().toUpperCase()).filter(s => s !== '');
    return arr.length > 0 ? arr : null;
};

/**
 * Controlador para analizar el origen de las compras con Filtros Responsivos.
 */
const getAnalisisOrigenCompras = async (req, res) => {
    try {
        const { 
            mes, anio, 
            almacenes, lineas, perfiles, generos, familias, 
            page, limit 
        } = req.query;

        // 1. Configuración de Fechas y Paginación
        const now = new Date();
        const fMes = parseInt(mes) || (now.getMonth() + 1);
        const fAnio = parseInt(anio) || now.getFullYear();
        
        const pPage = parseInt(page) || 1;
        const pLimit = parseInt(limit) || 50;
        const offset = (pPage - 1) * pLimit;

        // 2. Parsear filtros a arreglos para soporte de selección múltiple
        const targetAlmacenes = parseQueryArray(almacenes);
        const targetLineas = parseQueryArray(lineas);
        const targetPerfiles = parseQueryArray(perfiles);
        const targetGeneros = parseQueryArray(generos);
        const targetFamilias = parseQueryArray(familias);

        // 3. Obtener el Universo de Datos (Todo el mes)
        const comprasUniverso = await repo.obtenerComprasConsolidadas({ mes: fMes, anio: fAnio });

        // 4. Estructuras Set para garantizar opciones únicas (Sugerencias)
        const setAlmacenes = new Set();
        const setLineas = new Set();
        const setPerfiles = new Set();
        const setGeneros = new Set();
        const setFamilias = new Set();

        // 5. Variables para Métricas Finales y Datos Filtrados
        const datosFiltrados = [];
        let totalPartidas = 0;
        let partidasReposicion = 0;
        let partidasEspecial = 0;
        let montoTotal = 0;
        let montoReposicion = 0;
        let montoEspecial = 0;

        // Función booleana de validación
        const cumpleFiltro = (valRow, arrTarget) => {
            if (!arrTarget || arrTarget.length === 0) return true; // Si no hay filtro, pasa todo
            if (!valRow) return false;
            return arrTarget.includes(String(valRow).toUpperCase());
        };

        // 6. Iteración Maestra (Filtrado Cruzado y Cálculo de Métricas)
        comprasUniverso.forEach(row => {
            const valAlmacen = row.Almacen ? String(row.Almacen).trim() : null;
            const valLinea = row.Línea ? String(row.Línea).trim() : null;
            const valPerfil = row.Perfil ? String(row.Perfil).trim() : null;
            const valGenero = row.Genero ? String(row.Genero).trim() : null;
            const valFamilia = row.Familia ? String(row.Familia).trim() : null;

            // Evaluamos si esta fila cumple con cada filtro individualmente
            const mAlmacen = cumpleFiltro(valAlmacen, targetAlmacenes);
            const mLinea = cumpleFiltro(valLinea, targetLineas);
            const mPerfil = cumpleFiltro(valPerfil, targetPerfiles);
            const mGenero = cumpleFiltro(valGenero, targetGeneros);
            const mFamilia = cumpleFiltro(valFamilia, targetFamilias);

            // A) POBLAR CATÁLOGOS SUGERIDOS (Filtro Responsivo)
            // Para mostrar un Almacén, debe cumplir TODOS los demás filtros excepto el suyo propio
            if (mLinea && mPerfil && mGenero && mFamilia && valAlmacen) setAlmacenes.add(valAlmacen);
            
            // Para mostrar una Línea, debe cumplir Almacén, Perfil, Género y Familia
            if (mAlmacen && mPerfil && mGenero && mFamilia && valLinea) setLineas.add(valLinea);
            
            // Y así sucesivamente...
            if (mAlmacen && mLinea && mGenero && mFamilia && valPerfil) setPerfiles.add(valPerfil);
            if (mAlmacen && mLinea && mPerfil && mFamilia && valGenero) setGeneros.add(valGenero);
            if (mAlmacen && mLinea && mPerfil && mGenero && valFamilia) setFamilias.add(valFamilia);

            // B) RECOLECTAR DATOS Y MÉTRICAS (Coincidencia Absoluta)
            // Si la fila cumple absolutamente con TODOS los filtros, entra al cálculo
            if (mAlmacen && mLinea && mPerfil && mGenero && mFamilia) {
                datosFiltrados.push(row);
                
                totalPartidas++;
                
                const cantidad = parseFloat(row.Cantidad) || 0;
                const costo = parseFloat(row.Costo) || 0;
                const montoPartida = cantidad * costo;
                montoTotal += montoPartida;

                const origenTexto = (row.Origen || "").toUpperCase();
                const esReposicion = origenTexto.includes('REPOSICION') || origenTexto.includes('REPOSICIÓN');

                if (esReposicion) {
                    partidasReposicion++;
                    montoReposicion += montoPartida;
                } else {
                    partidasEspecial++;
                    montoEspecial += montoPartida;
                }
            }
        });

        // 7. Cálculos Finales y Ordenamiento
        const porcPartidasRep = totalPartidas > 0 ? round2((partidasReposicion / totalPartidas) * 100) : 0;
        const porcPartidasEsp = totalPartidas > 0 ? round2((partidasEspecial / totalPartidas) * 100) : 0;
        
        const porcMontoRep = montoTotal > 0 ? round2((montoReposicion / montoTotal) * 100) : 0;
        const porcMontoEsp = montoTotal > 0 ? round2((montoEspecial / montoTotal) * 100) : 0;

        const ordenarAlfa = (a, b) => a.localeCompare(b);
        const datosPaginados = datosFiltrados.slice(offset, offset + pLimit);

        // 8. Enviar Respuesta Estructurada
        res.json({
            periodo: { mes: fMes, anio: fAnio },
            filtros_aplicados: { 
                almacenes: targetAlmacenes, 
                lineas: targetLineas, 
                perfiles: targetPerfiles, 
                generos: targetGeneros, 
                familias: targetFamilias 
            },
            opciones_filtros: {
                almacenes: Array.from(setAlmacenes).sort(ordenarAlfa),
                lineas: Array.from(setLineas).sort(ordenarAlfa),
                perfiles: Array.from(setPerfiles).sort(ordenarAlfa),
                generos: Array.from(setGeneros).sort(ordenarAlfa),
                familias: Array.from(setFamilias).sort(ordenarAlfa)
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


/* const repo = require('../repositories/dashboardComprasRepository');
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

module.exports = { getAnalisisOrigenCompras }; */