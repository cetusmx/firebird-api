const repo = require('../repositories/dashboardComprasRepository');

const round2 = (num) => Math.round((num + Number.EPSILON) * 100) / 100;

const parseQueryArray = (param) => {
    if (!param) return null;
    const str = Array.isArray(param) ? param.join(',') : String(param);
    const arr = str.split(',').map(s => s.replace(/['"]/g, '').trim().toUpperCase()).filter(s => s !== '');
    return arr.length > 0 ? arr : null;
};

const getAnalisisOrigenCompras = async (req, res) => {
    try {
        // Soporte universal: Permite recibir los datos tanto por POST (body) como por GET (query)
        const payload = Object.keys(req.body || {}).length > 0 ? req.body : req.query;

        const { 
            mes, anio,                         // Parámetros versión anterior (compatibilidad)
            mes_inicio, anio_inicio,           // Nuevos parámetros de rango
            mes_fin, anio_fin,                 
            almacenes, lineas, perfiles, generos, familias, 
            page, limit 
        } = payload;

        const now = new Date();
        
        // LÓGICA DE FALLBACK: 
        // Si manda 'mes_inicio', lo usa. Si manda 'mes' antiguo, lo usa. Si no manda nada, usa mes actual.
        const mInicio = parseInt(mes_inicio) || parseInt(mes) || (now.getMonth() + 1);
        const aInicio = parseInt(anio_inicio) || parseInt(anio) || now.getFullYear();
        
        const mFin = parseInt(mes_fin) || parseInt(mes) || (now.getMonth() + 1);
        const aFin = parseInt(anio_fin) || parseInt(anio) || now.getFullYear();
        
        const pPage = parseInt(page) || 1;
        const pLimit = parseInt(limit) || 50;
        const offset = (pPage - 1) * pLimit;

        const targetAlmacenes = parseQueryArray(almacenes);
        const targetLineas = parseQueryArray(lineas);
        const targetPerfiles = parseQueryArray(perfiles);
        const targetGeneros = parseQueryArray(generos);
        const targetFamilias = parseQueryArray(familias);

        // Mandamos el rango de tiempo validado al repositorio
        const comprasUniverso = await repo.obtenerComprasConsolidadas({ 
            mes_inicio: mInicio, 
            anio_inicio: aInicio, 
            mes_fin: mFin, 
            anio_fin: aFin 
        });

        const setAlmacenes = new Set();
        const setLineas = new Set();
        const setPerfiles = new Set();
        const setGeneros = new Set();
        const setFamilias = new Set();

        const datosFiltrados = [];
        let totalPartidas = 0;
        let partidasReposicion = 0;
        let partidasEspecial = 0;
        let montoTotal = 0;
        let montoReposicion = 0;
        let montoEspecial = 0;

        const cumpleFiltro = (valRow, arrTarget) => {
            if (!arrTarget || arrTarget.length === 0) return true; 
            if (!valRow) return false;
            return arrTarget.includes(String(valRow).toUpperCase());
        };

        comprasUniverso.forEach(row => {
            const valAlmacen = row.Almacen ? String(row.Almacen).trim() : 'SIN ASIGNAR';
            const valLinea = row.Línea ? String(row.Línea).trim() : 'SIN ASIGNAR';
            const valPerfil = row.Perfil ? String(row.Perfil).trim() : 'SIN ASIGNAR';
            const valGenero = row.Genero ? String(row.Genero).trim() : 'SIN ASIGNAR';
            const valFamilia = row.Familia ? String(row.Familia).trim() : 'SIN ASIGNAR';

            const mAlmacen = cumpleFiltro(valAlmacen, targetAlmacenes);
            const mLinea = cumpleFiltro(valLinea, targetLineas);
            const mPerfil = cumpleFiltro(valPerfil, targetPerfiles);
            const mGenero = cumpleFiltro(valGenero, targetGeneros);
            const mFamilia = cumpleFiltro(valFamilia, targetFamilias);

            // A) POBLAR CATÁLOGOS SUGERIDOS
            if (mLinea && mPerfil && mGenero && mFamilia) setAlmacenes.add(valAlmacen);
            if (mAlmacen && mPerfil && mGenero && mFamilia) setLineas.add(valLinea);
            if (mAlmacen && mLinea && mGenero && mFamilia) setPerfiles.add(valPerfil);
            if (mAlmacen && mLinea && mPerfil && mFamilia) setGeneros.add(valGenero);
            if (mAlmacen && mLinea && mPerfil && mGenero) setFamilias.add(valFamilia);

            // B) RECOLECTAR DATOS Y MÉTRICAS
            if (mAlmacen && mLinea && mPerfil && mGenero && mFamilia) {
                
                const cantidad = parseFloat(row.Cantidad) || 0;
                const costo = parseFloat(row.Costo) || 0;
                const montoPartida = cantidad * costo;

                row.Subtotal = round2(montoPartida);
                row['Importe Total'] = round2(montoPartida * 1.16); 
                
                row.Almacen = valAlmacen;
                row.Línea = valLinea;
                row.Perfil = valPerfil;
                row.Genero = valGenero;
                row.Familia = valFamilia;

                datosFiltrados.push(row);
                totalPartidas++;
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

        const porcPartidasRep = totalPartidas > 0 ? round2((partidasReposicion / totalPartidas) * 100) : 0;
        const porcPartidasEsp = totalPartidas > 0 ? round2((partidasEspecial / totalPartidas) * 100) : 0;
        const porcMontoRep = montoTotal > 0 ? round2((montoReposicion / montoTotal) * 100) : 0;
        const porcMontoEsp = montoTotal > 0 ? round2((montoEspecial / montoTotal) * 100) : 0;

        const ordenarAlfa = (a, b) => a.localeCompare(b);
        const datosPaginados = datosFiltrados.slice(offset, offset + pLimit);

        res.json({
            // El periodo de respuesta refleja el rango consultado
            periodo: { 
                inicio: { mes: mInicio, anio: aInicio },
                fin: { mes: mFin, anio: aFin }
            },
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
                partidas: { total: totalPartidas, reposicion_cantidad: partidasReposicion, reposicion_porcentaje: porcPartidasRep, pedido_especial_cantidad: partidasEspecial, pedido_especial_porcentaje: porcPartidasEsp },
                montos: { total: round2(montoTotal), reposicion_monto: round2(montoReposicion), reposicion_porcentaje: porcMontoRep, pedido_especial_monto: round2(montoEspecial), pedido_especial_porcentaje: porcMontoEsp }
            },
            paginacion: { total_registros: totalPartidas, pagina_actual: pPage, limite: pLimit, total_paginas: Math.ceil(totalPartidas / pLimit) },
            data: datosPaginados
        });

    } catch (error) {
        console.error("Error en getAnalisisOrigenCompras:", error.message);
        res.status(500).json({ error: "Error interno al analizar origen", detalle: error.message });
    }
};

module.exports = { getAnalisisOrigenCompras };