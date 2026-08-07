const repo = require('../repositories/dashboardComprasRepository');

// Función auxiliar de redondeo estándar a 2 decimales
const round2 = (num) => Math.round((num + Number.EPSILON) * 100) / 100;

// Función para parsear parámetros separados por comas a arreglos limpios
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

        const now = new Date();
        const fMes = parseInt(mes) || (now.getMonth() + 1);
        const fAnio = parseInt(anio) || now.getFullYear();
        
        const pPage = parseInt(page) || 1;
        const pLimit = parseInt(limit) || 50;
        const offset = (pPage - 1) * pLimit;

        const targetAlmacenes = parseQueryArray(almacenes);
        const targetLineas = parseQueryArray(lineas);
        const targetPerfiles = parseQueryArray(perfiles);
        const targetGeneros = parseQueryArray(generos);
        const targetFamilias = parseQueryArray(familias);

        const comprasUniverso = await repo.obtenerComprasConsolidadas({ mes: fMes, anio: fAnio });

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
            // NORMALIZACIÓN DE NULOS: Convertimos vacíos en un string tangible para el filtro
            const valAlmacen = row.Almacen ? String(row.Almacen).trim() : 'SIN ASIGNAR';
            const valLinea = row.Línea ? String(row.Línea).trim() : 'SIN ASIGNAR';
            const valPerfil = row.Perfil ? String(row.Perfil).trim() : 'SIN ASIGNAR';
            const valGenero = row.Genero ? String(row.Genero).trim() : 'SIN ASIGNAR';
            const valFamilia = row.Familia ? String(row.Familia).trim() : 'SIN ASIGNAR';

            // Evaluamos si esta fila cumple con cada filtro
            const mAlmacen = cumpleFiltro(valAlmacen, targetAlmacenes);
            const mLinea = cumpleFiltro(valLinea, targetLineas);
            const mPerfil = cumpleFiltro(valPerfil, targetPerfiles);
            const mGenero = cumpleFiltro(valGenero, targetGeneros);
            const mFamilia = cumpleFiltro(valFamilia, targetFamilias);

            // A) POBLAR CATÁLOGOS SUGERIDOS (Filtro Responsivo)
            if (mLinea && mPerfil && mGenero && mFamilia) setAlmacenes.add(valAlmacen);
            if (mAlmacen && mPerfil && mGenero && mFamilia) setLineas.add(valLinea);
            if (mAlmacen && mLinea && mGenero && mFamilia) setPerfiles.add(valPerfil);
            if (mAlmacen && mLinea && mPerfil && mFamilia) setGeneros.add(valGenero);
            if (mAlmacen && mLinea && mPerfil && mGenero) setFamilias.add(valFamilia);

            // B) RECOLECTAR DATOS Y MÉTRICAS (Coincidencia Absoluta)
            if (mAlmacen && mLinea && mPerfil && mGenero && mFamilia) {
                // Inyectamos el valor normalizado al registro para que el frontend no rompa si espera texto
                row.Almacen = valAlmacen;
                row.Línea = valLinea;
                row.Perfil = valPerfil;
                row.Genero = valGenero;
                row.Familia = valFamilia;

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

        const porcPartidasRep = totalPartidas > 0 ? round2((partidasReposicion / totalPartidas) * 100) : 0;
        const porcPartidasEsp = totalPartidas > 0 ? round2((partidasEspecial / totalPartidas) * 100) : 0;
        const porcMontoRep = montoTotal > 0 ? round2((montoReposicion / montoTotal) * 100) : 0;
        const porcMontoEsp = montoTotal > 0 ? round2((montoEspecial / montoTotal) * 100) : 0;

        const ordenarAlfa = (a, b) => a.localeCompare(b);
        const datosPaginados = datosFiltrados.slice(offset, offset + pLimit);

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