---
permalink: /
title: ""
author_profile: true
redirect_from: 
  - /about/
  - /about.html
---
## About Me

I am John Yuehan Zhang, an undergraduate at Sichuan University and currently a visiting student at UC Berkeley. My research interests are fault-tolerant quantum computing, quantum error correction, and quantum computing architecture and compiler.

## Publications <small>(<sup>&#42;</sup> equal contribution)</small>

| Publication |
|-------------|
| [1] **John Yuehan Zhang**. *CircLS: Compiling Lattice Surgery to Physical Circuits with Dynamic Allocation*. arXiv:2608.23819, 2026. **(Under review at ASPLOS 2027)** [[paper](https://scirate.com/arxiv/2608.23819)] [[code](https://github.com/John-YuehanZhang/CircLS)] |
| [2] Keming He<sup>&#42;</sup>, **Yuehan Zhang**<sup>&#42;</sup>, Hongshun Yao, Jin-Guo Liu, and Xin Wang. *Block Coordinate Descent for Dynamic Portfolio Optimization on Finite-Precision Coherent Ising Machines*. arXiv:2603.23200, 2026. **(Under review at Quantum Science and Technology)** [[paper](https://scirate.com/arxiv/2603.23200)] |

## Research Experience

**CircLS: Compiling Lattice Surgery to Physical Circuits with Dynamic Allocation**

- **Unified lowering algorithm:** Designed a linear-time algorithm that lowers any Pauli product measurement (PPM) sequence to a stim circuit through stabilizer construction rules, so that a compiled program can be verified at the circuit level and its logical error rate (LER) measured from real samples.
- **Dynamic patch allocation:** Proposed allocating each data patch at its first use and freeing it at its last use, with freed tiles reused as ancilla paths; built a physical-level compiler around it, including a mapper that keeps ancilla paths short and a router that draws each PPM's path through the free tiles.
- **Comprehensive evaluation:** Against two prior toolchains, reduced the allocated spacetime volume by 34% and 27%, the LER by 40% and 48%, and the compile time by 98% and 96%, and compiled programs that they cannot.

**Block Coordinate Descent for Dynamic Portfolio Optimization on Finite-Precision Coherent Ising Machines**

- **QUBO modeling:** Formulated dynamic portfolio optimization as a QUBO problem, encoding expected returns, risk, transaction costs and budget constraints into one quadratic objective.
- **Scalability via BCD:** Proposed a block coordinate descent scheme that decomposes the QUBO along the time axis into bounded-size time-block subproblems with weak inter-block coupling, so that large instances fit the finite input precision of the hardware.
- **Quantum experiments:** Implemented the pipeline on a coherent Ising machine (CIM) and benchmarked it against classical solvers and gate-based quantum algorithms (e.g., QAOA), obtaining competitive portfolios with reduced runtime under hardware precision limits.

## Education

| Degree / Role | Institution | Years |
|---------------|-------------|-------|
| **Bachelor of Engineering in Cyber Science and Engineering** | *Sichuan University* | Sep 2023 – Jun 2027 |
| **Visiting Student** | *The Hong Kong University of Science and Technology (Guangzhou)* | Jul 2025 – Feb 2026 |
| **Visiting Student** | *University of California, Berkeley* | May 2026 – Present |

## Honors and Awards

- First Prize, 15th National College Student Mathematics Competition, Sichuan Division (Sep 2024)
- First Prize, 5th MathorCup Mathematical Application Challenge - Big Data Competition (Dec 2024)
- Honorable Mention, The Mathematical Contest in Modeling (MCM) (May 2025)

A PDF version of my CV is available [here](/files/CV_John_Yuehan_Zhang.pdf).
