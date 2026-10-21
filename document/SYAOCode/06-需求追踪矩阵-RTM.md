# 六、需求追踪矩阵（RTM）

**追踪链**：目标（G）与风险（R）→ 需求（FR / NFR）→ 业务规则（BR）→ 包 → 详细设计章节（DD）→ 测试。测试用例编号与需求同号：FR-nnn 对应 TC-nnn，NFR-nnn 对应 NT-nnn。测试层级：U 单元、I 集成、C 合约、E 端到端、V 评测、S 安全、P 性能。

## 6.1 功能需求追踪

| 需求 | 来源 | BR | 包 | DD | 测试层级 |
| --- | --- | --- | --- | --- | --- |
| FR-001 | G1 | - | core | DD-2 | U |
| FR-002 | G1 | BR-008/009/010 | core | DD-2 | U/I/V |
| FR-003 | G1 | BR-025 | core | DD-2 | U |
| FR-004 | G1 | BR-008 | core | DD-2 | U/I |
| FR-005 | G1 | BR-009 | core | DD-2 | I |
| FR-006 | G1 | BR-010 | core | DD-2 | U |
| FR-007 | G1 | BR-011 | core | DD-2 | U |
| FR-008 | G1 | - | core | DD-2 | I |
| FR-010 | G2 | BR-015 | providers | DD-3 | U/C |
| FR-011 | G2 | BR-014/015 | providers | DD-3 | C |
| FR-012 | G2 | BR-014 | providers | DD-3 | C |
| FR-013 | G2 | BR-014 | providers | DD-3 | C |
| FR-014 | G2 | BR-015 | providers | DD-3 | U |
| FR-015 | G2 | BR-014 | providers | DD-3 | U/I |
| FR-016 | G2 | BR-010 | providers | DD-3 | U |
| FR-017 | G2 | BR-014 | providers | DD-3 | U |
| FR-020 | G1/R-05 | BR-008 | core | DD-4 | U |
| FR-021 | G1/R-05 | BR-017 | core | DD-4 | U |
| FR-022 | G1/R-05 | BR-025 | core | DD-4 | U |
| FR-023 | G1/R-05 | BR-012 | core | DD-4 | U |
| FR-024 | G1/R-05 | BR-025 | core | DD-4 | U/I |
| FR-025 | G1/R-05 | - | core | DD-4 | U |
| FR-030 | G1/R-05 | BR-004 | tools | DD-4 | U |
| FR-031 | G1/R-05 | BR-004 | tools | DD-4 | U |
| FR-032 | G1/R-05 | BR-004/005 | tools | DD-4 | U/V |
| FR-033 | G1/R-05 | BR-004 | tools | DD-4 | U |
| FR-034 | G1/R-05 | BR-003 | tools | DD-4 | U |
| FR-035 | G1/R-05 | BR-006/012 | tools | DD-4 | U/S |
| FR-036 | G1/R-05 | BR-007 | tools | DD-4 | U/S |
| FR-037 | G1/R-05 | - | tools | DD-4 | U |
| FR-038 | G1/R-05 | - | tools | DD-4 | I |
| FR-040 | G5 | BR-001/021/024 | core | DD-5 | U/S |
| FR-041 | G5 | BR-001/002 | core | DD-5 | U/S |
| FR-042 | G5 | BR-003 | core | DD-5 | U/S |
| FR-043 | G5 | BR-006 | core | DD-5 | S |
| FR-044 | G5 | BR-001 | core | DD-5 | U |
| FR-045 | G5 | BR-023 | core | DD-5 | S |
| FR-046 | G5 | BR-007 | core | DD-5 | S/V |
| FR-047 | G5 | BR-004 | core | DD-5 | I |
| FR-050 | G1/R-08 | - | core | DD-6 | U |
| FR-051 | G1/R-08 | BR-024 | core | DD-6 | U |
| FR-052 | G1/R-08 | BR-013 | core | DD-6 | U |
| FR-053 | G1/R-08 | BR-013 | core | DD-6 | I/V |
| FR-054 | G1/R-08 | BR-012 | core | DD-6 | U |
| FR-055 | G1/R-08 | BR-016 | core | DD-6 | I |
| FR-060 | G1/R-08 | BR-016/023 | core | DD-7 | U/I |
| FR-061 | G1/R-08 | BR-016 | core | DD-7 | I |
| FR-062 | G1/R-08 | BR-016 | core | DD-7 | U |
| FR-063 | G1/R-08 | BR-023 | core | DD-7 | U |
| FR-070 | G3 | BR-017 | mcp | DD-8 | I/C |
| FR-071 | G3 | BR-017/018 | mcp | DD-8 | I/C |
| FR-072 | G3 | BR-018 | mcp | DD-8 | I/C |
| FR-073 | G3 | BR-023 | mcp | DD-8 | I |
| FR-074 | G3 | BR-017 | mcp | DD-8 | I |
| FR-075 | G3 | - | mcp | DD-8 | I |
| FR-076 | G3 | BR-018 | mcp | DD-8 | I |
| FR-077 | G3 | BR-001 | mcp | DD-8 | I |
| FR-080 | G3 | BR-001 | acp | DD-9 | C/E |
| FR-081 | G3 | - | acp | DD-9 | U |
| FR-082 | G3 | - | acp | DD-9 | U |
| FR-083 | G3 | BR-024 | core | DD-9 | U |
| FR-090 | R-07/R-14 | BR-019/020 | plugin | DD-10 | U |
| FR-091 | R-07/R-14 | BR-019 | plugin | DD-10 | I |
| FR-092 | R-07/R-14 | BR-019 | plugin | DD-10 | I |
| FR-093 | R-07/R-14 | BR-019 | plugin | DD-10 | I/S |
| FR-094 | R-07/R-14 | BR-020 | plugin | DD-10 | U |
| FR-095 | R-07/R-14 | - | plugin | DD-10 | E |
| FR-100 | R-06/R-07 | BR-021 | core | DD-11 | U/I |
| FR-101 | R-06/R-07 | BR-007 | core | DD-11 | I |
| FR-102 | R-06/R-07 | - | core | DD-11 | U |
| FR-103 | G7/R-24 | BR-022 | core | DD-11 | I/V |
| FR-110 | G9/R-09 | BR-023 | otel | DD-12 | I |
| FR-111 | G9/R-09 | BR-023 | core | DD-12 | U |
| FR-112 | G9/R-09 | BR-010 | core | DD-12 | U |
| FR-120 | G9 | BR-024 | core | DD-1 | U |
| FR-121 | G5/R-10 | BR-023 | core | DD-1 | S |
| FR-130 | G4 | BR-001 | cli | DD-13 | E |
| FR-131 | G4 | BR-001 | cli | DD-13 | E |
| FR-132 | G4 | BR-001 | cli | DD-13 | E |
| FR-133 | G4 | - | cli | DD-13 | E |

### 6.1.1 v0.3 新增功能需求追踪

| 需求 | 来源 | BR | 包 | DD | 测试层级 |
| --- | --- | --- | --- | --- | --- |
| FR-134 | G4 | BR-042 | cli | DD-13 | E |
| FR-135 | G4 | BR-042 | cli | DD-13 | E |
| FR-136 | G4 | BR-043 | cli | DD-13 | E |
| FR-137 | G4 | - | cli | DD-13 | E |
| FR-138 | G4 | - | cli | DD-13 | E |
| FR-139 | G4 | BR-050 | cli | DD-13 | E |
| FR-140 | G6 | BR-026 | decision | DD-16 | U/C |
| FR-141 | G6 | BR-031/036 | decision | DD-16 | C/I |
| FR-142 | G6 | BR-029 | decision | DD-16 | C/I |
| FR-143 | G6 | BR-026/030/035 | decision | DD-16 | U |
| FR-144 | G6 | BR-028 | decision | DD-16 | U/I |
| FR-145 | G6 | BR-027/032/038 | decision | DD-16 | U/V/S |
| FR-146 | G6 | BR-033 | decision | DD-16 | U/I |
| FR-147 | G6 | BR-029/034 | decision | DD-16 | I |
| FR-148 | G6 | BR-037/040 | decision | DD-16 | I/V |
| FR-149 | G6 | BR-039 | decision | DD-16 | I/V |
| FR-150 | G10/R-21 | BR-041 | server | DD-17 | I/S |
| FR-151 | G10/R-21 | BR-041 | cli/client | DD-17 | E |
| FR-152 | G10/R-21 | - | client | DD-17 | U/C |
| FR-153 | G10/R-21 | - | server | DD-17 | C |
| FR-154 | G10/R-21 | BR-041 | server | DD-17 | S |
| FR-155 | G10/R-21 | - | server | DD-17 | 评审 |
| FR-160 | G7 | BR-044 | agents | DD-18 | U |
| FR-161 | G7 | BR-049 | agents | DD-18 | U/I/V |
| FR-162 | G7 | BR-046/049 | agents | DD-18 | I/V |
| FR-163 | G7 | BR-044 | agents | DD-18 | I/V |
| FR-164 | G7 | BR-044/047 | agents | DD-18 | I/V |
| FR-165 | G7 | BR-045 | agents | DD-18 | U/C |
| FR-166 | G7 | BR-048 | agents | DD-18 | U/V |
| FR-167 | G7 | BR-048 | agents | DD-18 | U/E |
| FR-168 | G7 | BR-047 | agents | DD-18 | I |
| FR-169 | G7 | - | agents | DD-18 | I |
| FR-170 | G8/R-25 | BR-050 | agents | DD-19 | I/V |
| FR-171 | G8/R-25 | BR-051 | agents | DD-19 | I/E |
| FR-172 | G8/R-25 | BR-051 | agents | DD-19 | I/S |
| FR-173 | G4 | - | cli | DD-13 | E |
| FR-174 | G4 | BR-042 | cli | DD-13 | C/E |

## 6.2 非功能需求追踪

| 需求 | 来源 | 包 | DD | 测试层级 |
| --- | --- | --- | --- | --- |
| NFR-001 | G9 | core | DD-14 | P |
| NFR-002 | G9 | core | DD-2 | P |
| NFR-003 | G9/R-08 | core | DD-7 | P |
| NFR-004 | G9 | core | DD-2 | I |
| NFR-005 | R-07 | 全部 | DD-15 | I |
| NFR-006 | G9 | core | DD-7 | I |
| NFR-007 | G9 | 全部 | DD-15 | I |
| NFR-008 | G9 | 全部 | DD-14 | C |
| NFR-009 | G9 | 全部 | DD-1 | U |
| NFR-010 | G9 | core | DD-1 | U |
| NFR-011 | G9/R-13 | core | DD-14 | I |
| NFR-012 | G9/R-13 | core | DD-14 | U |
| NFR-013 | G9 | 全部 | DD-14 | I |
| NFR-014 | R-11 | 全部 | DD-14 | I |
| NFR-015 | R-14 | core | DD-14 | U |
| NFR-016 | G9 | core | DD-14 | P |
| NFR-017 | G5/R-05/06/10 | core | DD-5 | S |
| NFR-018 | R-14/R-15 | 全部 | DD-14 | S |
| NFR-019 | G9 | otel | DD-12 | I |
| NFR-020 | G9/R-12 | testing | DD-14 | U |
| NFR-021 | G9 | 全部 | DD-14 | U |
| NFR-022 | G9/R-13 | 全部 | DD-14 | U |
| NFR-023 | G9 | core | DD-15 | U |

### 6.2.1 v0.3 新增非功能需求追踪

| 需求 | 来源 | 包 | DD | 测试层级 |
| --- | --- | --- | --- | --- |
| NFR-024 | G6/R-19 | decision | DD-16 | P |
| NFR-025 | G6/R-16 | decision | DD-16 | I |
| NFR-026 | G6/R-18 | decision | DD-16 | S |
| NFR-027 | G4 | cli | DD-13 | P |
| NFR-028 | G10/R-21 | server | DD-17 | C |
| NFR-029 | G5/G10 | server | DD-17 | S |
| NFR-030 | G6/R-17 | decision | DD-16 | I |
| NFR-031 | G4 | cli | DD-13 | C |
| NFR-032 | G7/R-24 | agents | DD-18 | V |
| NFR-033 | G7/R-23 | agents | DD-18 | V |
| NFR-034 | G8/R-25 | agents | DD-19 | I |
| NFR-035 | G7/R-26 | agents | DD-18 | C/P |
## 6.3 追踪规则

1. 任何新增或变更的需求必须先更新 RTM，再进入设计与开发。
2. 每条 P0 的 FR 至少有一个 TC，且在 CI 中自动执行。
3. 发布前核对：RTM 中无「无设计」「无测试」的空行。
4. 风险登记册中的高风险项必须能在 RTM 中找到对应的需求与测试。

---
