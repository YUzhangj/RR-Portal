using System.Reflection;

// No database or copied parser implementation: exercise the actual migration assembly.
var type = Assembly.Load("ErpScopedMigration").GetType("BooleanSql", throwOnError: true)!;
var method = type.GetMethod("Canonical", BindingFlags.Static | BindingFlags.NonPublic)!;
string Canonical(string value) => (string)method.Invoke(null, [value])!;
var passed = 0;
void Check(string name, bool result)
{
    if (!result) throw new InvalidOperationException(name);
    passed++; Console.WriteLine("PASS " + name);
}
void Same(string name, string first, string second) => Check(name, Canonical(first) == Canonical(second));
void Different(string name, string first, string second) => Check(name, Canonical(first) != Canonical(second));
void Reject(string value)
{
    try { Canonical(value); }
    catch (TargetInvocationException error) when (error.InnerException?.GetType().Name == "MigrationRejected")
    { passed++; Console.WriteLine("PASS unsupported syntax rejected"); return; }
    throw new InvalidOperationException("Unsupported syntax was accepted");
}

// Each CHECK/default/filter used by ValidateSchema, including SQL Server's redundant wrappers.
Same("policy version CHECK", "采购政策版本 IS NULL OR 采购政策版本=1",
    "([采购政策版本] IS NULL OR [采购政策版本]=(1))");
Same("procurement snapshot CHECK", "采购政策版本 IS NULL OR (采购政策版本=1 AND 每库存单位KG>0 AND (每包重量 IS NULL OR 每包重量>0))",
    "([采购政策版本] IS NULL OR [采购政策版本]=(1) AND [每库存单位KG]>(0) AND ([每包重量] IS NULL OR [每包重量]>(0)))");
Same("issue mode CHECK", "原料扣减方式 IS NULL OR 原料扣减方式=N'领料出库'",
    "([原料扣减方式] IS NULL OR [原料扣减方式]=N'领料出库')");
Same("recipe ratios CHECK", "比例>0 AND 每库存单位KG>0", "([比例]>(0) AND [每库存单位KG]>(0))");
Same("frozen component quantities CHECK", "比例>0 AND 总比例>0 AND 用量KG>=0 AND 库存数量>=0 AND 每库存单位KG>0",
    "([比例]>(0) AND [总比例]>(0) AND [用量KG]>=(0) AND [库存数量]>=(0) AND [每库存单位KG]>(0))");
const string role = """
DATALENGTH(部门编号)=4 AND DATALENGTH(岗位代码)=LEN(岗位代码)*2 AND
((部门编号=N'06' AND (岗位代码 COLLATE Latin1_General_100_BIN2=N'06-clerk' OR 岗位代码 COLLATE Latin1_General_100_BIN2=N'06-supervisor' OR 岗位代码 COLLATE Latin1_General_100_BIN2=N'06-manager') AND 所属仓库 IS NULL)
 OR (部门编号=N'05' AND 岗位代码 COLLATE Latin1_General_100_BIN2=N'05-manager' AND 所属仓库 IS NULL)
 OR (部门编号=N'05' AND 岗位代码 COLLATE Latin1_General_100_BIN2=N'05-warehouse' AND 所属仓库 IS NOT NULL AND 所属仓库=N'原料仓' AND DATALENGTH(所属仓库)=6))
""";
const string storedRole = """
(datalength([部门编号])=(4) AND datalength([岗位代码])=(len([岗位代码])*(2)) AND
([部门编号]=N'06' AND ([岗位代码] collate Latin1_General_100_BIN2=N'06-clerk' OR [岗位代码] collate Latin1_General_100_BIN2=N'06-supervisor' OR [岗位代码] collate Latin1_General_100_BIN2=N'06-manager') AND [所属仓库] IS NULL
 OR [部门编号]=N'05' AND [岗位代码] collate Latin1_General_100_BIN2=N'05-manager' AND [所属仓库] IS NULL
 OR [部门编号]=N'05' AND [岗位代码] collate Latin1_General_100_BIN2=N'05-warehouse' AND [所属仓库] IS NOT NULL AND [所属仓库]=N'原料仓' AND datalength([所属仓库])=(6)))
""";
Same("role CHECK SQL Server formatting", role, storedRole);
Same("role timestamp default", "SYSDATETIME()", "(sysdatetime())");
Same("source index filter", "来源啤机采购单号 IS NOT NULL", "([来源啤机采购单号] IS NOT NULL)");
Same("constant and identifier wrappers", "DATALENGTH(代码)=LEN(代码)*2", "((DATALENGTH(([代码])))=(((LEN(([代码]))))*((2))))");
Different("LEN argument boundary is significant", "DATALENGTH(岗位代码)=LEN(岗位代码)*2", "DATALENGTH(岗位代码)=LEN(岗位代码*2)");
Different("role drift cannot hide argument arithmetic", role, role.Replace("LEN(岗位代码)*2", "LEN(岗位代码*2)"));
Different("addition/multiplication grouping is significant", "(a+b)*2=6", "a+b*2=6");
Different("subtraction grouping is significant", "a-(b-c)=0", "a-b-c=0");
Different("AND/OR precedence is significant", "a=1 OR (b=2 AND c=3)", "(a=1 OR b=2) AND c=3");
Same("boolean wrappers normalize", "a=1 OR (b=2 AND c=3)", "(([a]=(1)) OR (([b]=(2)) AND ([c]=(3))))");
Same("commutative AND ordering", "a=1 AND b=2", "b=2 AND a=1");
Same("quoted operators and escaped quotes remain literals", "name=N'AND OR Joe''s' AND id=1", "([id]=(1)) AND ([name]=N'AND OR Joe''s')");
Different("literal whitespace remains significant", "name=N'a b'", "name=N'ab'");
Different("literal parentheses remain significant", "name=N'(a)'", "name=N'a'");
Different("unicode literal marker remains significant", "name=N'a'", "name='a'");
Different("collation remains significant", "name COLLATE Latin1_General_100_BIN2=N'a'", "name COLLATE Latin1_General_100_CI_AS=N'a'");
foreach (var unsupported in new[] { "", "a IN (1,2)", "ABS(a)=1", "LEN(a,b)=1", "SYSDATETIME(a)",
    "a=1;", "a=1 -- ignored", "a=1 /* ignored */", "a=N'unclosed", "a=1 OR (b=2", "[unclosed=1", "a BETWEEN 1 AND 2" }) Reject(unsupported);
Console.WriteLine($"SUMMARY passed={passed} failed=0 databaseConnections=0");
