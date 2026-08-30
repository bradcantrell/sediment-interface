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

  // ── Domain mapping (identical to case_generator.py) ──
  const CANVAS_W = 1280;
  const CANVAS_H = 577;
  const SCALE = 0.01;            // 1 px = 0.01 m
  const DOMAIN_W = CANVAS_W * SCALE; // 12.8 m
  const DOMAIN_H = CANVAS_H * SCALE; // 5.77 m
  const DOMAIN_D = 2.0;          // channel depth (m) — deep enough for bed relief
  const NX_BG = 200;
  const NY_BG = 110;
  const NZ_BG = 32;
  const MAX_BED_RELIEF = 0.5;    // full design-strip elevation (px) -> physical bed relief (m)
  const DESIGN_STRIP_PX = 160;   // bed design strip height in canvas px
  const NX_STL = 100;            // bed STL grid (coarser than CFD mesh -> smaller export)
  const NY_STL = 55;

  function pxToM(px) { return px * SCALE; }

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
  function blockMeshDict() {
    const w = DOMAIN_W, h = DOMAIN_H, d = DOMAIN_D;
    const nx = NX_BG, ny = NY_BG, nz = NZ_BG;
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

  // ── Boundary entries for obstacle patches ──
  function obstacleEntries(obstacles, bcType, bcValue) {
    const lines = [];
    for (let i = 0; i < obstacles.length; i++) {
      lines.push('    obstacle' + i);
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

  function snappyHexMeshDict(obstacles, hasBed) {
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
      '    locationInMesh (' + fmtF(DOMAIN_W / 2, 4) + ' ' + fmtF(DOMAIN_H / 2, 4) + ' ' + fmtF(DOMAIN_D / 2, 4) + ');\n' +
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
        points: (o.points && o.type === 'poly') ? o.points.map(function (p) { return { x: p.x, y: p.y }; }) : []
      };
    });

    // Bed (optional) — carved by snappyHexMesh from bed.stl
    const bedProfile = state.bed_profile || [];
    const bedXsections = state.bed_xsections || [];
    const hasBed = bedProfile.length >= 2;
    const bed = hasBed
      ? profileToHeights(bedProfile, NX_STL, NY_STL, DOMAIN_W, DOMAIN_H, 0.02, state.heightsPng || null, bedXsections, state.width, state.height)
      : null;

    const files = [];
    const add = function (path, content) { files.push({ path: path, content: content }); };

    // system/
    add('system/controlDict', controlDict(1000, 100));
    add('system/fvSchemes', fvSchemes());
    add('system/fvSolution', fvSolution());
    add('system/blockMeshDict', blockMeshDict());
    add('system/snappyHexMeshDict', snappyHexMeshDict(obstacles, hasBed));
    add('system/surfaceFeatureExtractDict', surfaceFeatureExtractDict());

    // constant/
    add('constant/transportProperties', transportProperties());
    add('constant/turbulenceProperties', turbulenceProperties());
    add('constant/momentumTransport', momentumTransport());

    // constant/triSurface/ STL obstacles
    const zMin = -0.005, zMax = DOMAIN_D + 0.005;
    for (let i = 0; i < obstacles.length; i++) {
      const ob = obstacles[i];
      const cxM = pxToM(ob.x);
      const cyM = pxToM(DOMAIN_H / SCALE - ob.y); // flip y
      let stl;
      if (ob.type === 'circle') {
        const rM = pxToM((ob.w || ob.size) / 2);
        stl = stlCircle(cxM, cyM, rM, zMin, zMax);
      } else if (ob.type === 'poly') {
        const a = ob.rotation * Math.PI / 180;
        const cosA = Math.cos(a), sinA = Math.sin(a);
        const ptsM = [];
        for (const pt of ob.points) {
          const px = pt.x, py = pt.y;
          const wx = ob.x + px * cosA - py * sinA;
          const wy = ob.y + px * sinA + py * cosA;
          ptsM.push([pxToM(wx), pxToM(DOMAIN_H / SCALE - wy)]);
        }
        stl = stlPolygon(ptsM, zMin, zMax);
      } else {
        const hw = pxToM((ob.w || ob.size) / 2);
        const hh = pxToM((ob.h || ob.size) / 2);
        stl = stlRect(cxM, cyM, hw, hh, ob.rotation, zMin, zMax);
      }
      add('constant/triSurface/obstacle' + i + '.stl', stl);
    }

    // 0/ fields
    const uIn = String(state.inflow != null ? state.inflow : 2.5);
    add('0/U', initialU(obstacles, uIn));
    add('0/p', initialP(obstacles));
    add('0/k', initialK(obstacles));
    add('0/epsilon', initialEpsilon(obstacles));
    add('0/nut', initialNut(obstacles));

    // Bed files
    if (hasBed) {
      add('constant/triSurface/bed.stl', bedToSTL(bed, DOMAIN_W, DOMAIN_H));
      add('README.md', readmeMd(true));
    } else {
      add('README.md', readmeMd(false));
    }

    return {
      files: files,
      meta: {
        nx: NX_BG, ny: NY_BG, nz: NZ_BG,
        domainW: DOMAIN_W, domainH: DOMAIN_H, domainD: DOMAIN_D,
        nObstacles: obstacles.length,
        hasBed: (state.bed_profile || []).length >= 2
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
  function profileToHeights(bedProfile, nx, ny, domainW, domainH, maxDepth, heightsPng, bedXsections, canvasW, canvasH) {
    const canvasPxW = CANVAS_W;      // reference canvas width (px) the domain was derived from
    const canvasPxH = CANVAS_H;      // reference canvas height (px)
    const reliefScale = MAX_BED_RELIEF / DESIGN_STRIP_PX;  // strip px -> meters of relief
    const xScale = canvasW ? canvasPxW / canvasW : 1;      // actual canvas px -> reference px
    const yScale = canvasH ? canvasPxH / canvasH : 1;
    const points = (bedProfile || []).map(function (p) { return { x: p.x * xScale, z: p.z }; });
    const xsections = (bedXsections || []).map(function (xs) {
      return { x: xs.x * xScale, points: (xs.points || []).map(function (p) { return { y: p.y * yScale, z: p.z }; }) };
    });

    if (points.length < 2) {
      if (heightsPng) {
        const out = [];
        for (let y = 0; y < ny; y++) {
          const row = [];
          for (let x = 0; x < nx; x++) row.push(heightsPng[y][x] * maxDepth);
          out.push(row);
        }
        return out;
      }
      const flat = [];
      for (let y = 0; y < ny; y++) { flat.push(new Array(nx).fill(0.0)); }
      return flat;
    }

    const sortedPts = points.slice().sort(function (a, b) { return a.x - b.x; });

    // per-station y→z interpolators
    const stationMap = {};
    for (const xs of xsections) {
      const sx = xs.x;
      const ptsList = (xs.points || []).slice().sort(function (a, b) { return a.y - b.y; });
      if (ptsList.length < 2) continue;
      stationMap[sx] = function (yPx) {
        if (yPx <= ptsList[0].y) return ptsList[0].z;
        if (yPx >= ptsList[ptsList.length - 1].y) return ptsList[ptsList.length - 1].z;
        for (let k = 0; k < ptsList.length - 1; k++) {
          if (ptsList[k].y <= yPx && yPx <= ptsList[k + 1].y) {
            const t = (yPx - ptsList[k].y) / (ptsList[k + 1].y - ptsList[k].y);
            return ptsList[k].z + t * (ptsList[k + 1].z - ptsList[k].z);
          }
        }
        return 0;
      };
    }

    const stationXs = Object.keys(stationMap).map(Number).sort(function (a, b) { return a - b; });

    const bed = [];
    for (let j = 0; j < ny; j++) {
      const yPx = j * canvasPxH / ny;
      const row = [];
      for (let i = 0; i < nx; i++) {
        const xPx = i * canvasPxW / nx;

        let zLong;
        if (xPx <= sortedPts[0].x) zLong = sortedPts[0].z;
        else if (xPx >= sortedPts[sortedPts.length - 1].x) zLong = sortedPts[sortedPts.length - 1].z;
        else {
          zLong = sortedPts[0].z;
          for (let k = 0; k < sortedPts.length - 1; k++) {
            if (sortedPts[k].x <= xPx && xPx <= sortedPts[k + 1].x) {
              const t = (xPx - sortedPts[k].x) / (sortedPts[k + 1].x - sortedPts[k].x);
              zLong = sortedPts[k].z + t * (sortedPts[k + 1].z - sortedPts[k].z);
              break;
            }
          }
        }

        let zRel = 0;
        if (stationXs.length) {
          if (xPx <= stationXs[0]) zRel = stationMap[stationXs[0]](yPx);
          else if (xPx >= stationXs[stationXs.length - 1]) zRel = stationMap[stationXs[stationXs.length - 1]](yPx);
          else {
            for (let k = 0; k < stationXs.length - 1; k++) {
              if (stationXs[k] <= xPx && xPx <= stationXs[k + 1]) {
                const t = (xPx - stationXs[k]) / (stationXs[k + 1] - stationXs[k]);
                const za = stationMap[stationXs[k]](yPx);
                const zb = stationMap[stationXs[k + 1]](yPx);
                zRel = za + t * (zb - za);
                break;
              }
            }
          }
        }

        let h = Math.min(MAX_BED_RELIEF, Math.max(0, (zLong + zRel) * reliefScale));
        if (heightsPng) h += heightsPng[j][i] * maxDepth;
        row.push(h);
      }
      bed.push(row);
    }
    return bed;
  }

  // ── Bed heightfield → triangulated STL surface (for snappyHexMesh snapping) ──
  // bed: [ny][nx] heights in meters. Returns ASCII STL (top of bed at z=0, bed dips to -h).
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



  function readmeMd(hasBed) {
    let md = '# Sediment Interface \u2192 OpenFOAM case\n\n';
    md += '## Run (OpenFOAM 14)\n\n';
    md += '    blockMesh\n';
    md += '    snappyHexMesh -overwrite     # carves obstacles + bed from triSurface STLs\n';
    md += '    foamRun -solver incompressibleFluid\n\n';
    md += '## Files\n\n';
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
    profileToHeights: profileToHeights,
    bedToSTL: bedToSTL,
    readmeMd: readmeMd,
    crc32: crc32,
    constants: { CANVAS_W: CANVAS_W, CANVAS_H: CANVAS_H, SCALE: SCALE, DOMAIN_W: DOMAIN_W, DOMAIN_H: DOMAIN_H, DOMAIN_D: DOMAIN_D, NX_BG: NX_BG, NY_BG: NY_BG, NZ_BG: NZ_BG }
  };
});
