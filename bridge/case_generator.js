/*
 * Sediment Sim → OpenFOAM case generator (JS port of bridge/case_generator.py)
 * Generates a complete OpenFOAM case directory client-side, so the app can
 * "export case" (download a ZIP) instead of "bake" (call a Python server).
 *
 * UMD: works in Node (module.exports) and the browser (window.SedimentCaseGenerator).
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.SedimentCaseGenerator = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ── Domain mapping ──
  // The channel is always DOMAIN_W long. Its width follows the canvas: one scale factor maps
  // canvas pixels to metres in both directions (see domainFor), so the case has the shape of
  // the drawn scene at any window size. On the reference canvas (1280 x 577) 1 px = 0.01 m and
  // the domain is 12.8 x 5.77 m. (This once used the reference scale for the obstacles whatever
  // the canvas, and rescaled only the bed.)
  const CANVAS_W = 1280;
  const CANVAS_H = 577;
  const SCALE = 0.01;            // 1 px = 0.01 m on the reference canvas
  const DOMAIN_W = CANVAS_W * SCALE; // 12.8 m
  const DOMAIN_H = CANVAS_H * SCALE; // 5.77 m on the reference canvas
  const DOMAIN_D = 2.0;          // channel depth (m) — deep enough for bed relief
  const NX_BG = 200;
  const NY_BG = 110;
  const NZ_BG = 32;
  const MAX_BED_RELIEF = 0.5;    // full design-strip elevation (px) -> physical bed relief (m)
  const DESIGN_STRIP_PX = 160;   // bed design strip height in canvas px
  const NX_STL = 100;            // bed STL grid (coarser than CFD mesh -> smaller export)
  const NY_STL = 55;

  // The case's geometry for a canvas of width x height px: the scale, the domain, the mesh
  // counts across it (cells keep their reference size), and the one mapping from canvas
  // pixels (y down) to domain metres (y up).
  function domainFor(width, height) {
    const cw = width > 0 ? width : CANVAS_W, ch = height > 0 ? height : CANVAS_H;
    const s = DOMAIN_W / cw;
    const h = ch * s;
    return {
      canvasW: cw, canvasH: ch, s: s, w: DOMAIN_W, h: h, d: DOMAIN_D,
      nx: NX_BG, ny: Math.max(4, Math.round(NY_BG * h / DOMAIN_H)), nz: NZ_BG,
      nxStl: NX_STL, nyStl: Math.max(2, Math.round(NY_STL * h / DOMAIN_H)),
      toDomain: function (x, y) { return [x * s, (ch - y) * s]; },
    };
  }

  // ── Number formatting (Python-compatible) ──
  // Python "%.6e"  →  mantissa d.dddddd, exponent e±XX (sign always, 2+ digits)
  function fmtE(x) {
    if (x === 0) return '0.000000e+00';
    if (!isFinite(x)) return String(x);
    const s = x.toExponential(6);       // "1.234568e-7" | "1.000000e+0"
    const e = s.indexOf('e');
    const mant = s.slice(0, e);
    const exp = s.slice(e + 1);         // "-7" | "+0" | "+3"
    const sign = exp[0] === '-' ? '-' : '+';
    const mag = exp[0] === '-' ? exp.slice(1) : exp.slice(1);
    const magPadded = mag.padStart(2, '0');
    return mant + 'e' + sign + magPadded;
  }

  function fmtF(x, d) { return x.toFixed(d); }   // Python "%.4f" etc.

  function fmt2(x) { return x.toFixed(2); }

  // ── OpenFOAM file headers ──
  const HDR_V1912 = '/*--------------------------------*- C++ -*----------------------------------*\\\n' +
    '| =========                 |                                                 |\n' +
    '| \\\\      /  F ield         | OpenFOAM: The Open Source CFD Toolbox           |\n' +
    '|  \\\\    /   O peration     | Version:  v1912                                 |\n' +
    '|   \\\\  /    A nd           | Website:  www.openfoam.com                      |\n' +
    '|    \\\\/     M anipulation  |                                                 |\n' +
    '\\*---------------------------------------------------------------------------*/\n';

  const HDR_V14 = '/*--------------------------------*- C++ -*----------------------------------*\\\n' +
    '| =========                 |                                                 |\n' +
    '| \\\\      /  F ield         | OpenFOAM: The Open Source CFD Toolbox           |\n' +
    '|  \\\\    /   O peration     | Version:  v14                                   |\n' +
    '|   \\\\  /    A nd           | Website:  www.openfoam.org                      |\n' +
    '|    \\\\/     M anipulation  |                                                 |\n' +
    '\\*---------------------------------------------------------------------------*/\n';

  const FOAM_SEP = '// * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * //\n';

  function foamFile(header, className, objectName) {
    return header +
      'FoamFile\n' +
      '{\n' +
      '    version     2.0;\n' +
      '    format      ascii;\n' +
      '    class       ' + className + ';\n' +
      '    object      ' + objectName + ';\n' +
      '}\n' +
      FOAM_SEP;
  }

  // ── STL generation ──
  function addTri(triangles, v1, v2, v3, nx, ny, nz) {
    triangles.push(
      '  facet normal ' + fmtE(nx) + ' ' + fmtE(ny) + ' ' + fmtE(nz) + '\n' +
      '    outer loop\n' +
      '      vertex ' + fmtE(v1[0]) + ' ' + fmtE(v1[1]) + ' ' + fmtE(v1[2]) + '\n' +
      '      vertex ' + fmtE(v2[0]) + ' ' + fmtE(v2[1]) + ' ' + fmtE(v2[2]) + '\n' +
      '      vertex ' + fmtE(v3[0]) + ' ' + fmtE(v3[1]) + ' ' + fmtE(v3[2]) + '\n' +
      '    endloop\n' +
      '  endfacet\n'
    );
  }

  function stlCircle(cx, cy, r, zMin, zMax, nSegments) {
    nSegments = nSegments || 32;
    const tris = [];
    const angles = [];
    for (let i = 0; i < nSegments; i++) angles.push(2 * Math.PI * i / nSegments);

    // side faces
    for (let i = 0; i < nSegments; i++) {
      const a0 = angles[i], a1 = angles[(i + 1) % nSegments];
      const x0 = cx + r * Math.cos(a0), y0 = cy + r * Math.sin(a0);
      const x1 = cx + r * Math.cos(a1), y1 = cy + r * Math.sin(a1);
      const nx = Math.cos((a0 + a1) / 2), ny = Math.sin((a0 + a1) / 2);
      addTri(tris, [x0, y0, zMin], [x1, y1, zMin], [x1, y1, zMax], nx, ny, 0);
      addTri(tris, [x0, y0, zMin], [x1, y1, zMax], [x0, y0, zMax], nx, ny, 0);
    }

    // caps
    for (const [z, nz] of [[zMin, -1.0], [zMax, 1.0]]) {
      for (let i = 1; i < nSegments - 1; i++) {
        const x0 = cx + r * Math.cos(angles[0]), y0 = cy + r * Math.sin(angles[0]);
        const xi = cx + r * Math.cos(angles[i]), yi = cy + r * Math.sin(angles[i]);
        const xj = cx + r * Math.cos(angles[i + 1]), yj = cy + r * Math.sin(angles[i + 1]);
        if (nz > 0) addTri(tris, [x0, y0, z], [xj, yj, z], [xi, yi, z], 0, 0, nz);
        else addTri(tris, [x0, y0, z], [xi, yi, z], [xj, yj, z], 0, 0, nz);
      }
    }

    const name = 'circle_' + fmt2(cx) + '_' + fmt2(cy);
    return 'solid ' + name + '\n' + tris.join('') + 'endsolid ' + name + '\n';
  }

  function stlRect(cx, cy, halfW, halfH, rotDeg, zMin, zMax) {
    const corners = [[-halfW, -halfH], [halfW, -halfH], [halfW, halfH], [-halfW, halfH]];
    const rad = rotDeg * Math.PI / 180;
    const cosA = Math.cos(rad), sinA = Math.sin(rad);
    const rotated = corners.map(function (c) {
      return [cx + c[0] * cosA - c[1] * sinA, cy + c[0] * sinA + c[1] * cosA];
    });
    const tris = [];

    // side faces
    for (let i = 0; i < 4; i++) {
      const j = (i + 1) % 4;
      const x0 = rotated[i][0], y0 = rotated[i][1];
      const x1 = rotated[j][0], y1 = rotated[j][1];
      const dx = x1 - x0, dy = y1 - y0;
      const len = Math.sqrt(dx * dx + dy * dy);
      const nx = -dy / len, ny = dx / len;
      addTri(tris, [x0, y0, zMin], [x1, y1, zMin], [x1, y1, zMax], nx, ny, 0);
      addTri(tris, [x0, y0, zMin], [x1, y1, zMax], [x0, y0, zMax], nx, ny, 0);
    }

    // caps
    for (const [z, nz] of [[zMin, -1.0], [zMax, 1.0]]) {
      if (nz > 0) {
        addTri(tris, [rotated[0][0], rotated[0][1], z], [rotated[2][0], rotated[2][1], z], [rotated[1][0], rotated[1][1], z], 0, 0, nz);
        addTri(tris, [rotated[0][0], rotated[0][1], z], [rotated[3][0], rotated[3][1], z], [rotated[2][0], rotated[2][1], z], 0, 0, nz);
      } else {
        addTri(tris, [rotated[0][0], rotated[0][1], z], [rotated[1][0], rotated[1][1], z], [rotated[2][0], rotated[2][1], z], 0, 0, nz);
        addTri(tris, [rotated[0][0], rotated[0][1], z], [rotated[2][0], rotated[2][1], z], [rotated[3][0], rotated[3][1], z], 0, 0, nz);
      }
    }

    const name = 'rect_' + fmt2(cx) + '_' + fmt2(cy);
    return 'solid ' + name + '\n' + tris.join('') + 'endsolid ' + name + '\n';
  }

  function stlPolygon(ptsM, zMin, zMax) {
    const n = ptsM.length;
    const tris = [];
    let cx = 0, cy = 0;
    for (const p of ptsM) { cx += p[0]; cy += p[1]; }
    cx /= n; cy /= n;

    // side faces
    for (let i = 0; i < n; i++) {
      const x0 = ptsM[i][0], y0 = ptsM[i][1];
      const x1 = ptsM[(i + 1) % n][0], y1 = ptsM[(i + 1) % n][1];
      const dx = x1 - x0, dy = y1 - y0;
      const len = Math.sqrt(dx * dx + dy * dy);
      if (len === 0) continue;
      let nx = -dy / len, ny = dx / len;
      const mx = (x0 + x1) / 2, my = (y0 + y1) / 2;
      if (nx * (mx - cx) + ny * (my - cy) < 0) { nx = -nx; ny = -ny; }
      addTri(tris, [x0, y0, zMin], [x1, y1, zMin], [x1, y1, zMax], nx, ny, 0);
      addTri(tris, [x0, y0, zMin], [x1, y1, zMax], [x0, y0, zMax], nx, ny, 0);
    }

    // caps
    for (const [z, nz] of [[zMin, -1.0], [zMax, 1.0]]) {
      for (let i = 0; i < n; i++) {
        const x0 = ptsM[i][0], y0 = ptsM[i][1];
        const x1 = ptsM[(i + 1) % n][0], y1 = ptsM[(i + 1) % n][1];
        if (nz > 0) addTri(tris, [cx, cy, z], [x0, y0, z], [x1, y1, z], 0, 0, nz);
        else addTri(tris, [cx, cy, z], [x1, y1, z], [x0, y0, z], 0, 0, nz);
      }
    }

    const name = 'poly_' + n;
    return 'solid ' + name + '\n' + tris.join('') + 'endsolid ' + name + '\n';
  }

  // ── Dictionary generators ──
  function blockMeshDict(dom) {
    const w = dom.w, h = dom.h, d = dom.d;
    const nx = dom.nx, ny = dom.ny, nz = dom.nz;
    return foamFile(HDR_V1912, 'dictionary', 'blockMeshDict') +
      '\n' +
      'scale 1;\n' +
      '\n' +
      'vertices\n' +
      '(\n' +
      '    (0 0 0)              // 0\n' +
      '    (' + fmtF(w, 4) + ' 0 0)        // 1\n' +
      '    (' + fmtF(w, 4) + ' ' + fmtF(h, 4) + ' 0)  // 2\n' +
      '    (0 ' + fmtF(h, 4) + ' 0)        // 3\n' +
      '    (0 0 ' + fmtF(d, 4) + ')        // 4\n' +
      '    (' + fmtF(w, 4) + ' 0 ' + fmtF(d, 4) + ')  // 5\n' +
      '    (' + fmtF(w, 4) + ' ' + fmtF(h, 4) + ' ' + fmtF(d, 4) + ') // 6\n' +
      '    (0 ' + fmtF(h, 4) + ' ' + fmtF(d, 4) + ')  // 7\n' +
      ');\n' +
      '\n' +
      'blocks\n' +
      '(\n' +
      '    hex (0 1 2 3 4 5 6 7) (' + nx + ' ' + ny + ' ' + nz + ') simpleGrading (1 1 1)\n' +
      ');\n' +
      '\n' +
      'edges\n' +
      '(\n' +
      ');\n' +
      '\n' +
      'boundary\n' +
      '(\n' +
      '    inlet\n' +
      '    {\n' +
      '        type patch;\n' +
      '        faces\n' +
      '        (\n' +
      '            (0 4 7 3)\n' +
      '        );\n' +
      '    }\n' +
      '    outlet\n' +
      '    {\n' +
      '        type patch;\n' +
      '        faces\n' +
      '        (\n' +
      '            (1 2 6 5)\n' +
      '        );\n' +
      '    }\n' +
      '    top\n' +
      '    {\n' +
      '        type wall;\n' +
      '        faces\n' +
      '        (\n' +
      '            (3 7 6 2)\n' +
      '        );\n' +
      '    }\n' +
      '    bottom\n' +
      '    {\n' +
      '        type wall;\n' +
      '        faces\n' +
      '        (\n' +
      '            (0 1 5 4)\n' +
      '        );\n' +
      '    }\n' +
      '    frontAndBack\n' +
      '    {\n' +
      '        type symmetry;\n' +
      '        faces\n' +
      '        (\n' +
      '            (0 3 2 1)\n' +
      '            (4 5 6 7)\n' +
      '        );\n' +
      '    }\n' +
      ');\n' +
      '\n' +
      'mergePatchPairs\n' +
      '(\n' +
      ');\n';
  }

  function controlDict(endTime, writeInterval) {
    return foamFile(HDR_V1912, 'dictionary', 'controlDict') +
      '\n' +
      'application     foamRun;\n' +
      '\n' +
      'startFrom       startTime;\n' +
      'startTime       0;\n' +
      'stopAt          endTime;\n' +
      'endTime         ' + endTime + ';\n' +
      'deltaT          1;\n' +
      '\n' +
      'writeControl    runTime;\n' +
      'writeInterval   ' + writeInterval + ';\n' +
      'purgeWrite      2;\n' +
      'writeFormat     ascii;\n' +
      'writePrecision  8;\n' +
      'writeCompression off;\n' +
      'timeFormat      general;\n' +
      'timePrecision   6;\n' +
      'runTimeModifiable false;\n';
  }

  function fvSchemes() {
    return foamFile(HDR_V1912, 'dictionary', 'fvSchemes') +
      '\n' +
      'ddtSchemes { default steadyState; }\n' +
      'gradSchemes { default Gauss linear; }\n' +
      'divSchemes\n' +
      '{\n' +
      '    default         none;\n' +
      '    div(phi,U)      bounded Gauss linearUpwind grad(U);\n' +
      '    div(phi,k)      bounded Gauss upwind;\n' +
      '    div(phi,epsilon) bounded Gauss upwind;\n' +
      '    div((nuEff*dev2(T(grad(U))))) Gauss linear;\n' +
      '}\n' +
      'laplacianSchemes { default Gauss linear corrected; }\n' +
      'interpolationSchemes { default linear; }\n' +
      'snGradSchemes { default corrected; }\n';
  }

  function fvSolution() {
    return foamFile(HDR_V1912, 'dictionary', 'fvSolution') +
      '\n' +
      'solvers\n' +
      '{\n' +
      '    p\n' +
      '    {\n' +
      '        solver          GAMG;\n' +
      '        tolerance       1e-6;\n' +
      '        relTol          0.01;\n' +
      '        smoother        GaussSeidel;\n' +
      '    }\n' +
      '    U\n' +
      '    {\n' +
      '        solver          smoothSolver;\n' +
      '        smoother        GaussSeidel;\n' +
      '        tolerance       1e-6;\n' +
      '        relTol          0.1;\n' +
      '    }\n' +
      '    k\n' +
      '    {\n' +
      '        solver          smoothSolver;\n' +
      '        smoother        GaussSeidel;\n' +
      '        tolerance       1e-7;\n' +
      '        relTol          0.1;\n' +
      '    }\n' +
      '    epsilon\n' +
      '    {\n' +
      '        solver          smoothSolver;\n' +
      '        smoother        GaussSeidel;\n' +
      '        tolerance       1e-7;\n' +
      '        relTol          0.1;\n' +
      '    }\n' +
      '}\n' +
      '\n' +
      'SIMPLE\n' +
      '{\n' +
      '    nNonOrthogonalCorrectors 0;\n' +
      '    pRefCell        0;\n' +
      '    pRefValue       0;\n' +
      '    residualControl\n' +
      '    {\n' +
      '        p               1e-4;\n' +
      '        U               1e-4;\n' +
      '        k               1e-4;\n' +
      '        epsilon         1e-4;\n' +
      '    }\n' +
      '}\n' +
      '\n' +
      'relaxationFactors\n' +
      '{\n' +
      '    fields { p 0.3; }\n' +
      '    equations { U 0.7; k 0.7; epsilon 0.7; }\n' +
      '}\n';
  }

  function turbulenceProperties() {
    return foamFile(HDR_V1912, 'dictionary', 'turbulenceProperties') +
      '\n' +
      'simulationType  RAS;\n' +
      '\n' +
      'RAS\n' +
      '{\n' +
      '    RASModel        kEpsilon;\n' +
      '    turbulence      on;\n' +
      '    printCoeffs     on;\n' +
      '}\n';
  }

  function momentumTransport() {
    return foamFile(HDR_V14, 'dictionary', 'momentumTransport') +
      '\n' +
      'simulationType  RAS;\n' +
      '\n' +
      'RAS\n' +
      '{\n' +
      '    model           kEpsilon;\n' +
      '    turbulence      on;\n' +
      '    printCoeffs     on;\n' +
      '}\n';
  }

  function transportProperties() {
    return foamFile(HDR_V1912, 'dictionary', 'transportProperties') +
      '\n' +
      'viscosityModel  constant;\n' +
      'nu              [0 2 -1 0 0 0 0] 1e-06;  // water\n';
  }

  function surfaceFeatureExtractDict() {
    return 'FoamFile { version 2.0; format ascii; class dictionary; object surfaceFeatureExtractDict; }\n\n' +
      '// No feature edges extracted\n';
  }

  // ── Boundary entries for the wall patches snappyHexMesh adds ──
  // walls: the patch names, obstacle0.. and bed. Every patch in the mesh needs an entry in
  // every field. (bed had none, so a case with a bed stopped at foamRun's first read.)
  function obstacleEntries(walls, bcType, bcValue) {
    const lines = [];
    for (let i = 0; i < walls.length; i++) {
      lines.push('    ' + walls[i]);
      lines.push('    {');
      if (bcValue) {
        lines.push('        type            ' + bcType + ';');
        lines.push('        value           ' + bcValue + ';');
      } else {
        lines.push('        type            ' + bcType + ';');
      }
      lines.push('    }');
    }
    return lines.join('\n');
  }

  function snappyHexMeshDict(obstacles, hasBed, loc) {
    const stlNames = [];
    for (let i = 0; i < obstacles.length; i++) {
      stlNames.push('    obstacle' + i + ' { type triSurfaceMesh; file "obstacle' + i + '.stl"; }');
    }
    if (hasBed) stlNames.push('    bed { type triSurfaceMesh; file "bed.stl"; }');
    const stlBlock = stlNames.length ? stlNames.join('\n') : '    // no obstacles';

    const refinementLines = [];
    for (let i = 0; i < obstacles.length; i++) {
      refinementLines.push('        obstacle' + i);
      refinementLines.push('        {');
      refinementLines.push('            level (2 2);');
      refinementLines.push('        }');
    }
    if (hasBed) {
      refinementLines.push('        bed');
      refinementLines.push('        {');
      refinementLines.push('            level (1 1);');
      refinementLines.push('        }');
    }
    const refinementBlock = refinementLines.length ? refinementLines.join('\n') : '        // none';

    return foamFile(HDR_V1912, 'dictionary', 'snappyHexMeshDict') +
      '\n' +
      'castellatedMesh true;\n' +
      'snap            true;\n' +
      'addLayers       false;\n' +
      '\n' +
      'geometry\n' +
      '{\n' +
      stlBlock + '\n' +
      '};\n' +
      '\n' +
      'castellatedMeshControls\n' +
      '{\n' +
      '    maxLocalCells 500000;\n' +
      '    maxGlobalCells 2000000;\n' +
      '    minRefinementCells 10;\n' +
      '    maxLoadUnbalance 0.10;\n' +
      '    nCellsBetweenLevels 3;\n' +
      '\n' +
      '    resolveFeatureAngle 30;\n' +
      '    planarAngle 30;\n' +
      '    allowFreeStandingZoneFaces true;\n' +
      '\n' +
      '    features ();\n' +
      '\n' +
      '    refinementRegions\n' +
      '    {\n' +
      '    }\n' +
      '\n' +
      '    refinementSurfaces\n' +
      '    {\n' +
      refinementBlock + '\n' +
      '    }\n' +
      '\n' +
      '    locationInMesh (' + fmtF(loc[0], 4) + ' ' + fmtF(loc[1], 4) + ' ' + fmtF(loc[2], 4) + ');\n' +
      '}\n' +
      '\n' +
      'snapControls\n' +
      '{\n' +
      '    nSmoothPatch 3;\n' +
      '    tolerance 2.0;\n' +
      '    nSolveIter 30;\n' +
      '    nRelaxIter 5;\n' +
      '    nFeatureSnapIter 10;\n' +
      '}\n' +
      '\n' +
      'addLayersControls\n' +
      '{\n' +
      '    layers\n' +
      '    {\n' +
      '    }\n' +
      '    relativeSizes true;\n' +
      '    expansionRatio 1.0;\n' +
      '    finalLayerThickness 0.3;\n' +
      '    minThickness 0.1;\n' +
      '    nGrow 0;\n' +
      '    featureAngle 60;\n' +
      '    nRelaxIter 5;\n' +
      '    nSmoothSurfaceNormals 1;\n' +
      '    nSmoothNormals 3;\n' +
      '    nSmoothThickness 10;\n' +
      '    maxFaceThicknessRatio 0.5;\n' +
      '    maxThicknessToMedialRatio 0.3;\n' +
      '    minMedianAxisAngle 90;\n' +
      '    nBufferCellsNoExtrude 0;\n' +
      '    nLayerIter 50;\n' +
      '}\n' +
      '\n' +
      'meshQualityControls\n' +
      '{\n' +
      '    maxNonOrtho 65;\n' +
      '    maxBoundarySkewness 20;\n' +
      '    maxInternalSkewness 4;\n' +
      '    maxConcave 80;\n' +
      '    minFlatness 0.5;\n' +
      '    minVol 1e-13;\n' +
      '    minTetQuality 1e-9;\n' +
      '    minArea -1;\n' +
      '    minTwist 0.02;\n' +
      '    minDeterminant 0.001;\n' +
      '    minFaceWeight 0.02;\n' +
      '    minVolRatio 0.01;\n' +
      '    minTriangleTwist -1;\n' +
      '    nSmoothScale 4;\n' +
      '    errorReduction 0.75;\n' +
      '}\n' +
      '\n' +
      'writeFlags (scalarLevels layerSets layerFields);\n' +
      'mergeTolerance 1e-6;\n';
  }

  // ── 0/ field generators ──
  function initialU(obstacles, uIn) {
    const obsU = obstacleEntries(obstacles, 'fixedValue', 'uniform (0 0 0)');
    const obsBlock = obsU ? '\n' + obsU + '\n' : '';
    return foamFile(HDR_V1912, 'volVectorField', 'U') +
      '\n' +
      'dimensions      [0 1 -1 0 0 0 0];\n' +
      '\n' +
      'internalField   uniform (' + uIn + ' 0 0);\n' +
      '\n' +
      'boundaryField\n' +
      '{\n' +
      '    inlet\n' +
      '    {\n' +
      '        type            fixedValue;\n' +
      '        value           uniform (' + uIn + ' 0 0);\n' +
      '    }\n' +
      '    outlet\n' +
      '    {\n' +
      '        type            zeroGradient;\n' +
      '    }\n' +
      '    top\n' +
      '    {\n' +
      '        type            slip;\n' +
      '    }\n' +
      '    bottom\n' +
      '    {\n' +
      '        type            slip;\n' +
      '    }\n' +
      '    frontAndBack\n' +
      '    {\n' +
      '        type symmetry;\n' +
      '    }' + obsBlock +
      '\n}\n';
  }

  function initialP(obstacles) {
    const obsP = obstacleEntries(obstacles, 'zeroGradient');
    const obsBlock = obsP ? '\n' + obsP + '\n' : '';
    return foamFile(HDR_V1912, 'volScalarField', 'p') +
      '\n' +
      'dimensions      [0 2 -2 0 0 0 0];\n' +
      '\n' +
      'internalField   uniform 0;\n' +
      '\n' +
      'boundaryField\n' +
      '{\n' +
      '    inlet\n' +
      '    {\n' +
      '        type            zeroGradient;\n' +
      '    }\n' +
      '    outlet\n' +
      '    {\n' +
      '        type            fixedValue;\n' +
      '        value           uniform 0;\n' +
      '    }\n' +
      '    top\n' +
      '    {\n' +
      '        type            slip;\n' +
      '    }\n' +
      '    bottom\n' +
      '    {\n' +
      '        type            slip;\n' +
      '    }\n' +
      '    frontAndBack\n' +
      '    {\n' +
      '        type symmetry;\n' +
      '    }' + obsBlock +
      '\n}\n';
  }

  function initialK(obstacles) {
    const obsK = obstacleEntries(obstacles, 'kqRWallFunction', 'uniform 0.001');
    const obsBlock = obsK ? '\n' + obsK : '';
    return foamFile(HDR_V1912, 'volScalarField', 'k') +
      '\n' +
      'dimensions      [0 2 -2 0 0 0 0];\n' +
      '\n' +
      'internalField   uniform 0.001;\n' +
      '\n' +
      'boundaryField\n' +
      '{\n' +
      '    inlet   { type fixedValue; value uniform 0.001; }\n' +
      '    outlet  { type zeroGradient; }\n' +
      '    top     { type kqRWallFunction; value uniform 0.001; }\n' +
      '    bottom  { type kqRWallFunction; value uniform 0.001; }\n' +
      '    frontAndBack { type symmetry; }' + obsBlock +
      '\n}\n';
  }

  function initialEpsilon(obstacles) {
    const obsE = obstacleEntries(obstacles, 'epsilonWallFunction', 'uniform 0.0001');
    const obsBlock = obsE ? '\n' + obsE : '';
    return foamFile(HDR_V1912, 'volScalarField', 'epsilon') +
      '\n' +
      'dimensions      [0 2 -3 0 0 0 0];\n' +
      '\n' +
      'internalField   uniform 0.0001;\n' +
      '\n' +
      'boundaryField\n' +
      '{\n' +
      '    inlet   { type fixedValue; value uniform 0.0001; }\n' +
      '    outlet  { type zeroGradient; }\n' +
      '    top     { type epsilonWallFunction; value uniform 0.0001; }\n' +
      '    bottom  { type epsilonWallFunction; value uniform 0.0001; }\n' +
      '    frontAndBack { type symmetry; }' + obsBlock +
      '\n}\n';
  }

  function initialNut(obstacles) {
    const obsN = obstacleEntries(obstacles, 'nutkWallFunction', 'uniform 0');
    const obsBlock = obsN ? '\n' + obsN : '';
    return foamFile(HDR_V1912, 'volScalarField', 'nut') +
      '\n' +
      'dimensions      [0 2 -1 0 0 0 0];\n' +
      '\n' +
      'internalField   uniform 0;\n' +
      '\n' +
      'boundaryField\n' +
      '{\n' +
      '    inlet   { type calculated; value uniform 0; }\n' +
      '    outlet  { type calculated; value uniform 0; }\n' +
      '    top     { type nutkWallFunction; value uniform 0; }\n' +
      '    bottom  { type nutkWallFunction; value uniform 0; }\n' +
      '    frontAndBack { type symmetry; }' + obsBlock +
      '\n}\n';
  }

  // ── Case assembly ──
  // state: { obstacles: [{type,x,y,w,h,rotation,points:[{x,y}]}], inflow, width, height }
  // Returns { files: [{path, content}], meta: {...} }
  function generateCase(state) {
    const obstacles = (state.obstacles || []).map(function (o) {
      return {
        type: o.type,
        x: o.x || 0, y: o.y || 0,
        w: o.w || 0, h: o.h || 0,
        size: o.size || 0,
        rotation: o.rotation || 0,
        top: Number.isFinite(o.top) ? o.top : null,
        points: (o.points && o.type === 'poly') ? o.points.map(function (p) { return { x: p.x, y: p.y }; }) : []
      };
    });

    const dom = domainFor(state.width, state.height);

    // Bed (a drawn bed, a deposit, or both), carved by snappyHexMesh from bed.stl
    const bed = sceneBedHeights(state, dom);
    const hasBed = !!bed;
    let bedTop = 0;
    if (bed) for (const row of bed) for (const z of row) if (z > bedTop) bedTop = z;
    const loc = meshSeedPoint(obstacles, dom, bedTop);

    const files = [];
    const add = function (path, content) { files.push({ path: path, content: content }); };

    // system/
    add('system/controlDict', controlDict(1000, 100));
    add('system/fvSchemes', fvSchemes());
    add('system/fvSolution', fvSolution());
    add('system/blockMeshDict', blockMeshDict(dom));
    add('system/snappyHexMeshDict', snappyHexMeshDict(obstacles, hasBed, loc));
    add('system/surfaceFeatureExtractDict', surfaceFeatureExtractDict());

    // constant/
    add('constant/transportProperties', transportProperties());
    add('constant/turbulenceProperties', turbulenceProperties());
    add('constant/momentumTransport', momentumTransport());

    // constant/triSurface/ STL obstacles. An object's top is metres above the water surface
    // (the river's slider). One that stands above it goes through the lid, as every object
    // used to; one under it is carved to its height, so the water flows over it. (The lid is
    // rigid here too, so a wall across the channel cannot spill as the live model's dam does.)
    const zMin = -0.005;
    for (let i = 0; i < obstacles.length; i++) {
      const ob = obstacles[i];
      const zMax = (ob.top != null && ob.top < 0) ? Math.max(0.05, DOMAIN_D + ob.top) : DOMAIN_D + 0.005;
      const c = dom.toDomain(ob.x, ob.y);
      let stl;
      if (ob.type === 'circle') {
        stl = stlCircle(c[0], c[1], (ob.w || ob.size) / 2 * dom.s, zMin, zMax);
      } else if (ob.type === 'poly') {
        stl = stlPolygon(polyWorldPoints(ob).map(function (p) { return dom.toDomain(p[0], p[1]); }), zMin, zMax);
      } else {
        // The canvas's y runs down, the domain's up: a rotation on the canvas is the same
        // angle the other way in the domain.
        stl = stlRect(c[0], c[1], (ob.w || ob.size) / 2 * dom.s, (ob.h || ob.size) / 2 * dom.s, -ob.rotation, zMin, zMax);
      }
      add('constant/triSurface/obstacle' + i + '.stl', stl);
    }

    // 0/ fields
    const uIn = String(state.inflow != null ? state.inflow : 2.5);
    const walls = obstacles.map(function (o, i) { return 'obstacle' + i; }).concat(hasBed ? ['bed'] : []);
    add('0/U', initialU(walls, uIn));
    add('0/p', initialP(walls));
    add('0/k', initialK(walls));
    add('0/epsilon', initialEpsilon(walls));
    add('0/nut', initialNut(walls));

    // Bed files
    if (hasBed) {
      add('constant/triSurface/bed.stl', bedToSTL(bed, dom.w, dom.h));
      add('README.md', readmeMd(true));
    } else {
      add('README.md', readmeMd(false));
    }

    // One command that runs the case, and the scene itself so the interface can open it again.
    add('Allrun', allrunSh());
    if (typeof state.sceneText === 'string' && state.sceneText) add('scene.json', state.sceneText);

    return {
      files: files,
      meta: {
        nx: dom.nx, ny: dom.ny, nz: dom.nz,
        domainW: dom.w, domainH: dom.h, domainD: dom.d, scale: dom.s,
        locationInMesh: loc,
        nObstacles: obstacles.length,
        hasBed: hasBed
      }
    };
  }

  // ── Minimal ZIP writer (STORE, no compression) ──
  const CRC_TABLE = (function () {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c >>> 0;
    }
    return t;
  })();

  function crc32(bytes) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i++) {
      c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    }
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  function utf8Bytes(str) {
    if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(str);
    // fallback (Node < 11 / old browsers)
    const bytes = [];
    for (let i = 0; i < str.length; i++) {
      let code = str.codePointAt(i);
      if (code < 0x80) bytes.push(code);
      else if (code < 0x800) { bytes.push(0xC0 | (code >> 6), 0x80 | (code & 63)); }
      else if (code < 0x10000) { bytes.push(0xE0 | (code >> 12), 0x80 | ((code >> 6) & 63), 0x80 | (code & 63)); }
      else { bytes.push(0xF0 | (code >> 18), 0x80 | ((code >> 12) & 63), 0x80 | ((code >> 6) & 63), 0x80 | (code & 63)); i++; }
    }
    return new Uint8Array(bytes);
  }

  // files: [{path, content}] → Uint8Array (valid ZIP)
  function buildZip(files) {
    const enc = utf8Bytes;
    const chunks = [];
    const central = [];
    let offset = 0;

    for (const f of files) {
      const nameBytes = enc(f.path);
      const dataBytes = enc(f.content);
      const crc = crc32(dataBytes);
      const size = dataBytes.length;

      // Local file header
      const lh = new DataView(new ArrayBuffer(30));
      lh.setUint32(0, 0x04034b50, true);
      lh.setUint16(4, 20, true);         // version needed
      lh.setUint16(6, 0x0800, true);     // UTF-8 flag
      lh.setUint16(8, 0, true);          // method = store
      lh.setUint16(10, 0, true);         // mod time
      lh.setUint16(12, 0x0021, true);    // mod date (1980-01-01)
      lh.setUint32(14, crc, true);
      lh.setUint32(18, size, true);      // compressed size
      lh.setUint32(22, size, true);      // uncompressed size
      lh.setUint16(26, nameBytes.length, true);
      lh.setUint16(28, 0, true);         // extra length

      chunks.push(new Uint8Array(lh.buffer), nameBytes, dataBytes);

      // Central directory entry
      const cd = new DataView(new ArrayBuffer(46));
      cd.setUint32(0, 0x02014b50, true);
      cd.setUint16(4, 20, true);         // version made by
      cd.setUint16(6, 20, true);         // version needed
      cd.setUint16(8, 0x0800, true);     // flags
      cd.setUint16(10, 0, true);         // method
      cd.setUint16(12, 0, true);         // mod time
      cd.setUint16(14, 0x0021, true);    // mod date
      cd.setUint32(16, crc, true);
      cd.setUint32(20, size, true);
      cd.setUint32(24, size, true);
      cd.setUint16(28, nameBytes.length, true);
      cd.setUint16(30, 0, true);         // extra len
      cd.setUint16(32, 0, true);         // comment len
      cd.setUint16(34, 0, true);         // disk number
      cd.setUint16(36, 0, true);         // internal attrs
      cd.setUint32(38, 0, true);         // external attrs
      cd.setUint32(42, offset, true);    // local header offset

      central.push(new Uint8Array(cd.buffer), nameBytes);

      offset += 30 + nameBytes.length + size;
    }

    const centralStart = offset;
    let centralSize = 0;
    for (const c of central) centralSize += c.length;

    // End of central directory
    const eocd = new DataView(new ArrayBuffer(22));
    eocd.setUint32(0, 0x06054b50, true);
    eocd.setUint16(4, 0, true);
    eocd.setUint16(6, 0, true);
    eocd.setUint16(8, files.length, true);
    eocd.setUint16(10, files.length, true);
    eocd.setUint32(12, centralSize, true);
    eocd.setUint32(16, centralStart, true);
    eocd.setUint16(20, 0, true);

    const all = [].concat(chunks, central, [new Uint8Array(eocd.buffer)]);
    const total = all.reduce(function (s, a) { return s + a.length; }, 0);
    const out = new Uint8Array(total);
    let p = 0;
    for (const a of all) { out.set(a, p); p += a.length; }
    return out;
  }

  // ── Bed heightfield (port of displace_bed.profile_to_heights) ──
  // bed_profile: [{x,z}] px; bed_xsections: [{x, points:[{y,z}]}]
  // heightsPng: 2D [ny][nx] in [0..1] (optional, decoded from depo PNG)
  // Returns [ny][nx] heights in meters.
  // ── The bed, as the interface has it ──
  // The same bed the page's flow sees: the drawn long profile with each station's cross-section
  // (computeUserBedZ / getStationZ in index.html, ported here), held to the river's 0..160 px
  // relief, plus the deposit grid (depoZ). A station with no cross-section is flat across, and
  // the bed fades between neighbouring stations, as on the page. Returns [ny][nx] heights in
  // metres at the STL nodes (row 0 is the domain's y = 0, the canvas's bottom edge), or null
  // when there is neither a drawn bed nor any deposit.
  // (This once interpolated only between stations that had a cross-section, holding a single
  // section along the whole channel; did not flip y; and read the deposit from the brightness
  // of the top-left 100 x 55 pixels of the deposit image.)
  const BED_RELIEF_MAX_PX = 160;   // the river's clamp on the drawn bed (model.js)
  function stationZ(station, sections, y) {
    const xs = sections.find(function (q) { return q.x === station.x; });
    if (!xs || !xs.points || xs.points.length < 2) return station.z;
    const pts = xs.points.slice().sort(function (a, b) { return a.y - b.y; });
    if (y <= pts[0].y) return station.z + pts[0].z;
    if (y >= pts[pts.length - 1].y) return station.z + pts[pts.length - 1].z;
    for (let k = 0; k < pts.length - 1; k++) {
      if (pts[k].y <= y && y <= pts[k + 1].y) {
        const t = (y - pts[k].y) / (pts[k + 1].y - pts[k].y);
        return station.z + pts[k].z + t * (pts[k + 1].z - pts[k].z);
      }
    }
    return station.z;
  }
  function userBedZ(stations, sections, x, y) {
    if (stations.length < 2) return 0;
    if (x <= stations[0].x) return stationZ(stations[0], sections, y);
    const last = stations[stations.length - 1];
    if (x >= last.x) return stationZ(last, sections, y);
    for (let k = 0; k < stations.length - 1; k++) {
      const a = stations[k], b = stations[k + 1];
      if (a.x <= x && x <= b.x) {
        const t = b.x > a.x ? (x - a.x) / (b.x - a.x) : 0;
        const za = stationZ(a, sections, y);
        return za + t * (stationZ(b, sections, y) - za);
      }
    }
    return 0;
  }
  function depositZ(dep, x, y) {
    if (!dep || !dep.grid || !(dep.gw > 1) || !(dep.gh > 1)) return 0;
    const cell = dep.cell || 4;
    // Clamped to the grid, so the domain's edges carry the deposit next to them.
    const fx = Math.min(dep.gw - 1, Math.max(0, x / cell - 0.5));
    const fy = Math.min(dep.gh - 1, Math.max(0, y / cell - 0.5));
    const i = Math.min(dep.gw - 2, Math.floor(fx)), j = Math.min(dep.gh - 2, Math.floor(fy));
    const tx = fx - i, ty = fy - j, g = dep.grid, W = dep.gw;
    const a = g[j * W + i], b = g[j * W + i + 1], c = g[(j + 1) * W + i], d = g[(j + 1) * W + i + 1];
    return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
  }
  function sceneBedHeights(state, dom) {
    const stations = (state.bed_profile || []).slice().sort(function (a, b) { return a.x - b.x; });
    const sections = state.bed_xsections || [];
    const dep = state.deposit || null;
    let anyDeposit = false;
    if (dep && dep.grid) for (let k = 0; k < dep.grid.length; k++) if (dep.grid[k] > 0) { anyDeposit = true; break; }
    if (stations.length < 2 && !anyDeposit) return null;
    const mPerPx = MAX_BED_RELIEF / DESIGN_STRIP_PX;   // bed units -> metres of relief
    const nx = dom.nxStl, ny = dom.nyStl, bed = [];
    for (let j = 0; j < ny; j++) {
      const y = dom.canvasH - j * dom.canvasH / (ny - 1);  // node j sits at domain y = j * h / (ny - 1)
      const row = [];
      for (let i = 0; i < nx; i++) {
        const x = i * dom.canvasW / (nx - 1);
        const z = Math.min(BED_RELIEF_MAX_PX, Math.max(0, userBedZ(stations, sections, x, y))) + depositZ(dep, x, y);
        row.push(z * mPerPx);
      }
      bed.push(row);
    }
    return bed;
  }

  // ── The point snappyHexMesh keeps the mesh around ──
  // snappyHexMesh keeps the region that holds locationInMesh. Fixed at the domain centre, an
  // obstacle drawn there made it keep only the inside of the obstacle: no inlet, no outlet,
  // and checkMesh still said OK. The point is now looked for from the inlet end, clear of every
  // obstacle by two background cells and above the bed; if there is none the export fails.
  function polyWorldPoints(ob) {
    const a = (ob.rotation || 0) * Math.PI / 180, cosA = Math.cos(a), sinA = Math.sin(a);
    return (ob.points || []).map(function (p) { return [ob.x + p.x * cosA - p.y * sinA, ob.y + p.x * sinA + p.y * cosA]; });
  }
  function nearObstacle(ob, x, y, m) {
    const dx = x - ob.x, dy = y - ob.y;
    if (ob.type === 'circle') return Math.hypot(dx, dy) < (ob.w || ob.size) / 2 + m;
    if (ob.type === 'poly') {
      const pts = polyWorldPoints(ob);
      let inside = false;
      for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
        const xi = pts[i][0], yi = pts[i][1], xj = pts[j][0], yj = pts[j][1];
        if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
        const ex = xj - xi, ey = yj - yi, L2 = ex * ex + ey * ey;
        const t = L2 > 0 ? Math.max(0, Math.min(1, ((x - xi) * ex + (y - yi) * ey) / L2)) : 0;
        if (Math.hypot(x - (xi + t * ex), y - (yi + t * ey)) < m) return true;
      }
      return inside;
    }
    const a = (ob.rotation || 0) * Math.PI / 180;
    const lx = dx * Math.cos(a) + dy * Math.sin(a), ly = -dx * Math.sin(a) + dy * Math.cos(a);
    return Math.abs(lx) < (ob.w || ob.size) / 2 + m && Math.abs(ly) < (ob.h || ob.size) / 2 + m;
  }
  function meshSeedPoint(obstacles, dom, bedTop) {
    if (bedTop > dom.d - 0.1) throw new Error('the bed fills the channel (' + bedTop.toFixed(2) + ' m of ' + dom.d + ' m)');
    const z = (bedTop + dom.d) / 2;
    const m = 2 * (dom.w / dom.nx) / dom.s;            // two background cells, in canvas px
    const xs = [0.03, 0.06, 0.1, 0.15, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 0.97];
    const ys = [0.5, 0.4, 0.6, 0.3, 0.7, 0.2, 0.8, 0.1, 0.9, 0.05, 0.95];
    for (const fx of xs) for (const fy of ys) {
      const x = fx * dom.canvasW, y = fy * dom.canvasH;
      if (!obstacles.some(function (ob) { return nearObstacle(ob, x, y, m); })) {
        const p = dom.toDomain(x, y);
        return [p[0], p[1], z];
      }
    }
    throw new Error('no point in the channel is clear of the obstacles, so the mesh has nowhere to start');
  }

  // ── Bed heightfield → triangulated STL surface (for snappyHexMesh snapping) ──
  // bed: [ny][nx] heights in metres above the channel floor, row j at y = j * domainH / (ny - 1).
  function bedToSTL(bed, domainW, domainH) {
    const ny = bed.length, nx = bed[0].length;
    const tris = [];
    const cellW = domainW / (nx - 1);
    const cellH = domainH / (ny - 1);

    function pt(i, j) {
      const x = i * cellW;
      const y = j * cellH;
      const z = bed[j][i];
      return [x, y, z];
    }

    for (let j = 0; j < ny - 1; j++) {
      for (let i = 0; i < nx - 1; i++) {
        const a = pt(i, j), b = pt(i + 1, j), c = pt(i + 1, j + 1), d = pt(i, j + 1);
        // two triangles per cell; normal +z (upward, toward fluid)
        addTri(tris, a, c, b, 0, 0, 1);
        addTri(tris, a, d, c, 0, 0, 1);
      }
    }
    return 'solid bed\n' + tris.join('') + 'endsolid bed\n';
  }



  // The three steps of the README as one script. A ZIP made in the browser carries no
  // executable bit, so the README runs it through sh.
  function allrunSh() {
    return '#!/bin/sh\n' +
      '# Runs this case from start to finish with OpenFOAM 14:  sh Allrun\n' +
      'cd "$(dirname "$0")" || exit 1\n' +
      'if ! command -v foamRun >/dev/null 2>&1; then\n' +
      '  echo "OpenFOAM 14 is not set up in this shell. Load it first, for example:" >&2\n' +
      '  echo "  . /opt/openfoam14/etc/bashrc" >&2\n' +
      '  exit 1\n' +
      'fi\n' +
      'step() {\n' +
      '  echo "$1 ..."\n' +
      '  if ! "$@" > "log.$1" 2>&1; then echo "$1 failed, see log.$1" >&2; exit 1; fi\n' +
      '}\n' +
      'step blockMesh\n' +
      'step snappyHexMesh -overwrite\n' +
      '# snappyHexMesh keeps one connected region. If it is not the channel (an obstacle that\n' +
      '# closes it off), the mesh has no inlet or outlet and the run would mean nothing.\n' +
      'for patch in inlet outlet; do\n' +
      '  n=$(awk -v p="$patch" \'$1 == p { f = 1 } f && $1 == "nFaces" { sub(";", "", $2); print $2; exit }\' constant/polyMesh/boundary)\n' +
      '  if [ -z "$n" ] || [ "$n" -eq 0 ]; then echo "the mesh has no $patch: an obstacle closes the channel off, see log.snappyHexMesh" >&2; exit 1; fi\n' +
      'done\n' +
      'step foamRun -solver incompressibleFluid\n' +
      'echo "done. Open the result with:  paraFoam   (or paraview, after: touch case.foam)"\n';
  }

  function readmeMd(hasBed) {
    let md = '# Sediment Interface \u2192 OpenFOAM case\n\n';
    md += '## Run (OpenFOAM 14)\n\n';
    md += 'Unpack the ZIP, load OpenFOAM 14 in a shell, and from this folder run\n\n';
    md += '    sh Allrun\n\n';
    md += 'which runs these three steps and writes a log for each:\n\n';
    md += '    blockMesh\n';
    md += '    snappyHexMesh -overwrite     # carves obstacles + bed from triSurface STLs\n';
    md += '    foamRun -solver incompressibleFluid\n\n';
    md += '## Open the scene again\n\n';
    md += 'scene.json is the drawing this case was made from. In the Sediment Interface, on the\n';
    md += 'river tab, press "open" and pick scene.json or the ZIP itself.\n\n';
    md += '## Files\n\n';
    md += '    Allrun     - runs the three steps above\n';
    md += '    scene.json - the scene, for the interface\n';
    md += '    system/    - controlDict, fvSchemes, fvSolution, blockMeshDict, snappyHexMeshDict\n';
    md += '    constant/  - transportProperties, turbulenceProperties, momentumTransport, triSurface/ (obstacle + bed STLs)\n';
    md += '    0/         - U, p, k, epsilon, nut initial/boundary fields\n';
    if (hasBed) {
      md += '    constant/triSurface/bed.stl - bed surface, carved by snappyHexMesh\n';
    }
    return md;
  }

  // ── Public API ──
  return {
    generateCase: generateCase,
    buildZip: buildZip,
    domainFor: domainFor,
    sceneBedHeights: sceneBedHeights,
    meshSeedPoint: meshSeedPoint,
    bedToSTL: bedToSTL,
    readmeMd: readmeMd,
    crc32: crc32,
    constants: { CANVAS_W: CANVAS_W, CANVAS_H: CANVAS_H, SCALE: SCALE, DOMAIN_W: DOMAIN_W, DOMAIN_H: DOMAIN_H, DOMAIN_D: DOMAIN_D, NX_BG: NX_BG, NY_BG: NY_BG, NZ_BG: NZ_BG }
  };
});
