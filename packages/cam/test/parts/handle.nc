(swarf: Handle with a rounded end)
(grblHAL lathe, lathe, mm)
(stock: bar Ø20, 75 out of the chuck, raw face at Z1)
(X is a diameter; Z0 = finished front face)
G21 G90 G94 G54
G18 G7 G97

(op1: Profile Ø16–Ø20 to Z-58, T1 Turning, CCMT 09 R0.4 carbide)
(Load T1: Turning, CCMT 09 R0.4 carbide, touch off, then cycle start)
(from wherever it is then, the tool goes along Z to Z23, then to X34)
M0
G21 G90 G94 G54
G18 G7 G97
G0 Z23
G0 X34
S2387 M3
G4 P2
X24 Z3
Z2
X18.04
G1 Z-44.99 F286
X19.04 Z-44.49
G0 Z2
X24
X16.08
G1 Z-4.077
X17.08 Z-3.577
G0 Z2
X24
X14.12
G1 Z-2.017
X15.12 Z-1.517
G0 Z2
X24
X12.16
G1 Z-1.013
X13.16 Z-0.513
G0 Z2
X24
X10.2
G1 Z-0.391
X11.2 Z0.109
G0 Z2
X24
X8.24
G1 Z-0.011
X9.24 Z0.489
G0 Z2
X24
X0.4
G1 Z0.2
X5.2
G3 X16.4 Z-5.4 I-0.001 K-5.601
G1 Z-20.39
X18.396 Z-50.33
G3 X18.4 Z-50.45 I-3.728 K-0.122
G1 Z-57.382
G2 X19.272 Z-57.801 I0.407 K-0.013
G1 X21
G0 X24
Z3
Z2
X0
G1 Z0
X5.2
G3 X16 Z-5.4 I0 K-5.4
G1 Z-20.393
X17.996 Z-50.337
G3 X18 Z-50.45 I-3.489 K-0.115
G1 Z-57.388
G2 X19.248 Z-58.001 I0.604 K-0.009
G1 X21
G0 X24
Z3
Z23
X34

(op2: Part off at Z-62, T2 Parting blade 2 mm)
M5
(Change to T2: Parting blade 2 mm, touch off, then cycle start)
(from wherever it is then, the tool goes along Z to Z23, then to X34)
M0
G21 G90 G94 G54
G18 G7 G97
G0 Z23
G0 X34
S1910 M3
G4 P2
X24 Z3
Z-62
X21
G1 X0 F96
G0 X21
X24
Z3
Z23
X34

M5
M30
