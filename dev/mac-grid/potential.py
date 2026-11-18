# Independent check: discrete potential flow (5-point Laplace, inflow flux 2.5 per row on the left,
# phi = 0 half a cell past the right edge, closed banks) through the R8 wall: cols 79-83, rows 3-66 solid.
import numpy as np, scipy.sparse as sp, scipy.sparse.linalg as spl
NX, NY = 160, 90
solid = np.zeros((NX+2, NY+2), bool)
solid[79:84, 3:67] = True
idx = -np.ones((NX+2, NY+2), int); n = 0
for j in range(1, NY+1):
    for i in range(1, NX+1):
        if not solid[i, j]: idx[i, j] = n; n += 1
A = sp.lil_matrix((n, n)); b = np.zeros(n)
for j in range(1, NY+1):
    for i in range(1, NX+1):
        k = idx[i, j]
        if k < 0: continue
        for di, dj in ((1,0),(-1,0),(0,1),(0,-1)):
            ii, jj = i+di, j+dj
            if ii == 0: b[k] += 2.5; continue          # inflow flux into the cell
            if ii == NX+1: A[k, k] += 2; continue      # phi = 0 at the outflow face
            if jj < 1 or jj > NY or solid[ii, jj]: continue
            A[k, k] += 1; A[k, idx[ii, jj]] -= 1
phi = spl.spsolve(A.tocsr(), b)
# flux to the right through the face between col 81 and 82 = phi[81] - phi[82]
f = lambda j: phi[idx[81, j]] - phi[idx[82, j]] if idx[81, j] >= 0 else 0.0
slot = f(1) + f(2); tot = sum(f(j) for j in range(1, NY+1))
print('slot', round(slot, 1), 'total', round(tot, 1), 'share', round(100*slot/tot), '%', 'u rows 1,2', round(f(1), 1), round(f(2), 1))
